# FUNCTIONS AND POLICIES — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. Migrations `0009`–`0012`: the atomic commit operation, the sync
procedure, every RLS policy as SQL, and the grant/revoke set.

Tables, types and the availability view are in `SCHEMA.md`. Custom SQLSTATE codes
(`KY001`–`KY006`) are defined there.

**Migrations are WRITTEN, NEVER APPLIED.**

---

## 1. `0009_fn_record_commitment.sql` — the concurrency-controlled write path

### Mechanism, chosen and justified

**Chosen: `SELECT … FOR UPDATE` on the `inventory` row, inside a `SECURITY DEFINER` plpgsql
function, exposed as a PostgREST RPC.**

The row lock is taken on `inventory(sku, location)` — the exact contended resource — *before*
the availability figure is read. Every concurrent caller for the same SKU serialises behind
it; callers for different SKUs never block each other.

Why this and not the alternatives:

- **Not a serializable transaction.** `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` must be
  the first statement in a transaction. Inside a PostgREST-invoked function the transaction
  has already begun, so the function cannot set it. It would also surface as SQLSTATE `40001`
  (`could not serialize access`), which obliges every caller to implement retry logic — a lot
  of machinery to end up telling the loser the same thing.
- **Not a CHECK constraint on a derived total.** A CHECK cannot reference other rows, so this
  would require a denormalised `qty_committed_portal` column maintained by a trigger. Same
  guarantee, one more thing to keep correct, and a second source of truth for a number that
  is already derivable.
- **Not an advisory lock.** `pg_advisory_xact_lock(hashtext(sku || location))` works, but
  hash collisions make unrelated SKUs contend for no reason, and — the deciding argument — an
  advisory lock does **not** conflict with a plain `UPDATE` of the inventory row. A sync
  writing a new baseline would run straight through it. `FOR UPDATE` takes the real row lock
  that `apply_inventory_sync`'s `UPDATE` also needs, so commit-versus-sync is serialised too,
  not just commit-versus-commit.

**A naive read-then-write is a failure of this plan, not of the build.** Concretely, this is
forbidden: reading availability from `v_inventory` (or from the client) and then inserting.
The read must happen *after* the lock, against the base tables, inside the same transaction.

```sql
CREATE OR REPLACE FUNCTION public.record_commitment(
  p_sku      text,
  p_qty      integer,
  p_location text DEFAULT 'default',
  p_note     text DEFAULT NULL
)
RETURNS public.commitments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_inv       public.inventory%ROWTYPE;
  v_pending   integer;
  v_available integer;
  v_row       public.commitments;
BEGIN
  -- Identity comes from the signed JWT and nowhere else. NOTE: there is deliberately no
  -- p_rep_id parameter. A caller cannot record a commitment on another rep's behalf,
  -- which is what keeps this SECURITY DEFINER function from being an RLS bypass.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'KY002';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer' USING ERRCODE = 'KY004';
  END IF;

  -- (1) TAKE THE LOCK FIRST. This is the whole mechanism. It serialises against other
  --     record_commitment calls for this SKU and against apply_inventory_sync, which
  --     UPDATEs the same row. Exactly one row is locked per call, so no deadlock is
  --     possible from this function.
  SELECT * INTO v_inv
  FROM public.inventory
  WHERE sku = p_sku AND location = p_location
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no inventory row for sku % at location %', p_sku, p_location
      USING ERRCODE = 'KY005';
  END IF;

  -- (2) Recompute the ledger INSIDE the lock. Never trust a client-supplied availability
  --     figure, and never read this before the lock is held.
  SELECT COALESCE(SUM(c.qty), 0) INTO v_pending
  FROM public.commitments c
  WHERE c.sku = p_sku AND c.location = p_location AND c.state = 'pending';

  v_available := v_inv.qty_on_hand - v_inv.qty_committed - v_pending;

  IF p_qty > v_available THEN
    RAISE EXCEPTION
      'insufficient availability for % at %: requested %, available %',
      p_sku, p_location, p_qty, GREATEST(v_available, 0)
      USING ERRCODE = 'KY001',
            HINT    = 'INSUFFICIENT_AVAILABILITY';
  END IF;

  INSERT INTO public.commitments (sku, location, qty, rep_id, state, note)
  VALUES (p_sku, p_location, p_qty, v_uid, 'pending', p_note)
  RETURNING * INTO v_row;

  RETURN v_row;
  -- The lock is released at COMMIT, which PostgREST issues when the RPC returns.
END;
$$;
```

### What the losing session is told

At the database: SQLSTATE **`KY001`**, message
`insufficient availability for SEA-9006 at default: requested 1, available 0`.

At the route handler (`app/api/commitments/route.ts`), `lib/errors.ts` maps `KY001` to
**HTTP 409 Conflict** with this body:

```json
{
  "error": "INSUFFICIENT_AVAILABILITY",
  "message": "Only 0 available — another rep committed the last unit first.",
  "sku": "SEA-9006",
  "location": "default",
  "requested": 1,
  "available": 0
}
```

The handler branches on `error.code === 'KY001'` (the SQLSTATE, which `@supabase/supabase-js`
surfaces as `PostgrestError.code`), **never** on message text. Full mapping table in §4 of
`PLAN.md`.

There is no UI for this in step 1. The message text is specified now because it is part of
what attack 2 asserts, and because step 2 will need it unchanged.

---

## 2. `0010_fn_apply_inventory_sync.sql` — matching-only retirement

### What "matching" means, concretely

A pending commitment becomes `confirmed_in_source` **only** when the sync payload contains a
`matches` entry that names it by its portal `id` and agrees on every identifying field:

```
ALL of the following must hold, or it is not a match:
  match.commitment_id = commitments.id
  match.sku           = commitments.sku
  match.location      = commitments.location
  match.qty           = commitments.qty
  commitments.state   = 'pending'
```

Anything else is recorded in the run report as `match_fields_disagree` or
`unknown_commitment` and the commitment **stays pending**.

**Matching is explicit and never inferred.** In particular, there is no quantity-absorption
heuristic — the function never reasons "the source's committed figure went up by 6, so retire
six units' worth of the oldest pending commitments." That heuristic silently retires the
wrong commitments whenever two reps commit the same SKU, and it is the failure mode this
requirement exists to catch.

**What happens to a commitment the sync does not mention: it persists, unchanged, in
`pending`, and it keeps reducing `available`. For as long as that takes.** There is no time
limit, no expiry, no grace period, and no "the sync ran and did not find it, so it must be
gone." That is not a side effect of the implementation — it is the default behaviour, because
the function only ever touches commitments named in `matches`.

**There is no `now()`, no `interval`, no `age()`, and no date comparison anywhere in the
retirement path.** Builder must not add one. `SCHEMA.md` §5 backs this up structurally: the
state trigger rejects `pending → retired`, so even a hostile or careless future cron job
cannot retire a live delta in one step.

Nothing in this run sets `retired`. That transition exists in the schema and is legal from
`confirmed_in_source`, but no code path reaches it until step 3.

```sql
CREATE OR REPLACE FUNCTION public.apply_inventory_sync(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id    uuid  := gen_random_uuid();
  v_rows      jsonb := COALESCE(p_payload -> 'rows',    '[]'::jsonb);
  v_matches   jsonb := COALESCE(p_payload -> 'matches', '[]'::jsonb);
  v_row       jsonb;
  v_match     jsonb;
  v_updated   integer := 0;
  v_overrides integer := 0;
  v_confirmed integer := 0;
  v_unmatched integer := 0;
  v_rejected  jsonb := '[]'::jsonb;
  v_inv       public.inventory%ROWTYPE;
  v_c         public.commitments%ROWTYPE;
BEGIN
  -- ROLE GUARD — FAIL CLOSED, WITHIN THIS FILE.
  --
  -- Deny by default. Exactly two callers are permitted:
  --   * an admin  (public.is_admin(), which reads profiles.role via the signed JWT's sub)
  --   * service_role, for the unattended sync (auth.role() reads the JWT's role claim)
  --
  -- Both COALESCEs are load-bearing. auth.role() is NULL when there is no request.jwt.claims
  -- GUC, and in plpgsql `IF NULL THEN` does not fire — an un-COALESCEd expression would be
  -- fail-OPEN, which is the exact defect this amendment removes.
  IF NOT (
       COALESCE(public.is_admin(), false)
       OR COALESCE(auth.role(), '') = 'service_role'
     ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = 'KY003';
  END IF;

  ----------------------------------------------------------------------------
  -- 1. Apply the baseline rows.
  --    Locked in a deterministic (sku, location) order so two concurrent syncs
  --    cannot deadlock against each other.
  ----------------------------------------------------------------------------
  FOR v_row IN
    SELECT e.value
    FROM jsonb_array_elements(v_rows) AS e(value)
    ORDER BY e.value ->> 'sku', e.value ->> 'location'
  LOOP
    SELECT * INTO v_inv
    FROM public.inventory
    WHERE sku = v_row ->> 'sku'
      AND location = COALESCE(v_row ->> 'location', 'default')
    FOR UPDATE;

    IF NOT FOUND THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'unknown_sku_location', 'row', v_row);
      CONTINUE;
    END IF;

    IF v_inv.source = 'manual_override' THEN
      -- NEVER silently overwrite an admin override. Record what the source claimed,
      -- leave the displayed quantities alone. This is inventory_authority = 'quickbooks'
      -- behaviour at the data layer: show both numbers, never silently override.
      UPDATE public.inventory
      SET source_payload = COALESCE(source_payload, '{}'::jsonb)
                           || jsonb_build_object('last_source_snapshot', v_row,
                                                 'last_source_seen_at', now())
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_overrides := v_overrides + 1;
    ELSE
      UPDATE public.inventory
      SET qty_on_hand    = (v_row ->> 'qty_on_hand')::integer,
          qty_committed  = (v_row ->> 'qty_committed')::integer,
          qty_incoming   = (v_row ->> 'qty_incoming')::integer,
          incoming_eta   = NULLIF(v_row ->> 'incoming_eta', '')::date,
          source         = COALESCE((v_row ->> 'source')::public.inventory_source,
                                    'quickbooks_stub'::public.inventory_source),
          source_payload = v_row,
          updated_at     = now()
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  ----------------------------------------------------------------------------
  -- 2. Retire deltas BY EXPLICIT MATCH ONLY.
  --    No elapsed-time comparison appears anywhere in this block, by design.
  --    A commitment absent from p_payload->'matches' is not touched: it stays
  --    pending and keeps reducing available.
  ----------------------------------------------------------------------------
  FOR v_match IN SELECT e.value FROM jsonb_array_elements(v_matches) AS e(value)
  LOOP
    SELECT * INTO v_c
    FROM public.commitments
    WHERE id = (v_match ->> 'commitment_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'unknown_commitment', 'match', v_match);
      CONTINUE;
    END IF;

    IF v_c.state <> 'pending'
       OR v_c.sku      <> (v_match ->> 'sku')
       OR v_c.location <> (v_match ->> 'location')
       OR v_c.qty      <> (v_match ->> 'qty')::integer THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'match_fields_disagree',
                           'match', v_match, 'commitment_id', v_c.id);
      CONTINUE;
    END IF;

    UPDATE public.commitments
    SET state        = 'confirmed_in_source',
        source_ref   = v_match ->> 'source_ref',
        confirmed_at = now()
    WHERE id = v_c.id;

    v_confirmed := v_confirmed + 1;
  END LOOP;

  SELECT count(*) INTO v_unmatched FROM public.commitments WHERE state = 'pending';

  INSERT INTO public.inventory_sync_runs
    (id, run_by, rows_applied, overrides_preserved,
     commitments_confirmed, commitments_still_pending, report)
  VALUES
    (v_run_id, auth.uid(), v_updated, v_overrides,
     v_confirmed, v_unmatched, jsonb_build_object('rejected', v_rejected));

  RETURN jsonb_build_object(
    'run_id',                    v_run_id,
    'rows_applied',              v_updated,
    'overrides_preserved',       v_overrides,
    'commitments_confirmed',     v_confirmed,
    'commitments_still_pending', v_unmatched,
    'rejected',                  v_rejected
  );
END;
$$;
```

### Payload shape

```jsonc
{
  "rows": [
    { "sku": "SEA-1042", "location": "default",
      "qty_on_hand": 40, "qty_committed": 10, "qty_incoming": 0,
      "incoming_eta": null, "source": "quickbooks_stub" }
  ],
  "matches": [
    { "commitment_id": "…uuid…", "sku": "SEA-1042", "location": "default",
      "qty": 6, "source_ref": "SO-10241" }
  ]
}
```

`matches` is optional and is empty for every stub sync. That is the normal case, and it is
exactly the case attack 3 exercises.

### Deadlock analysis

`record_commitment` locks one `inventory` row, then reads `commitments` without locking.
`apply_inventory_sync` locks `inventory` rows in `(sku, location)` order, then locks
`commitments` rows by id. The two never acquire locks in opposing order, so no deadlock is
reachable between them.

---

## 3. `0011_rls_policies.sql` — every policy, as SQL

RLS was enabled on each table in its creating migration. Until this file is applied every
table is deny-all, which is the correct intermediate state.

Every policy is scoped `TO authenticated`. `anon` gets no policies at all, and additionally
has its grants revoked in `0012` — belt and braces, because a policy is only reachable if the
grant exists.

### `profiles`

```sql
-- A rep sees exactly one row: their own. An admin sees all.
CREATE POLICY profiles_select_self_or_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

-- Admin-only. No rep has any write path to this table, which is what makes
-- self-promotion to admin unreachable through the API.
CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
```

No INSERT policy: profiles are created by `handle_new_user()` / `ensure_profile()`, both
`SECURITY DEFINER`. No DELETE policy: profiles follow `auth.users` via `ON DELETE CASCADE`.

### `products`

```sql
-- The catalogue is readable by every signed-in user. It is not secret.
CREATE POLICY products_select_authenticated ON public.products
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY products_insert_admin ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY products_update_admin ON public.products
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY products_delete_admin ON public.products
  FOR DELETE TO authenticated
  USING (public.is_admin());
```

### `inventory`

```sql
CREATE POLICY inventory_select_authenticated ON public.inventory
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY inventory_insert_admin ON public.inventory
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- Attack 1 asserts this refuses a rep's write. Attack 4 asserts the same thing from the
-- role-enforcement direction.
CREATE POLICY inventory_update_admin ON public.inventory
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY inventory_delete_admin ON public.inventory
  FOR DELETE TO authenticated
  USING (public.is_admin());
```

### `commitments` — one policy, deliberately

```sql
-- A rep reads their own commitments and nobody else's. An admin reads all.
-- This is the predicate attack 1 targets directly.
CREATE POLICY commitments_select_own_or_admin ON public.commitments
  FOR SELECT TO authenticated
  USING (rep_id = auth.uid() OR public.is_admin());
```

**There is deliberately no INSERT, UPDATE or DELETE policy on `commitments`, for any role,
including admin.**

An INSERT policy would let a rep write a commitment row directly and skip the availability
check inside `record_commitment()` — which would make the concurrency control (§1) trivially
bypassable and defeat requirement 2. Every write to this table goes through a
`SECURITY DEFINER` function that takes the row lock first. Nothing else can write here.

An UPDATE policy would let a client edit `state` and bypass the lifecycle trigger's intent.
State transitions belong to `apply_inventory_sync()` and, later, step 3's admin functions.

Direct `INSERT`/`UPDATE`/`DELETE` from any client therefore fails with SQLSTATE `42501`
(`new row violates row-level security policy` / `permission denied`). Attacks 1 and 4 assert
this for `rep`, and attack 4 asserts it for `admin` too — this is not a privilege the admin
role has either.

### `app_settings`

```sql
-- Every signed-in user must read inventory_authority and the thresholds to render the list.
CREATE POLICY app_settings_select_authenticated ON public.app_settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY app_settings_update_admin ON public.app_settings
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
```

No INSERT policy (the singleton row is inserted by migration `0006`), no DELETE policy.

### `inventory_sync_runs`

```sql
-- Admin only. A rep has no business reading sync internals, and this gives attack 1 a
-- second forbidden-read target that is not commitments.
CREATE POLICY sync_runs_select_admin ON public.inventory_sync_runs
  FOR SELECT TO authenticated
  USING (public.is_admin());
```

No INSERT/UPDATE/DELETE policies: rows are written only by `apply_inventory_sync()`
(`SECURITY DEFINER`).

### Policy matrix — what each role may do, per table

| Table | rep SELECT | rep INSERT | rep UPDATE | rep DELETE | admin SELECT | admin INSERT | admin UPDATE | admin DELETE |
|---|---|---|---|---|---|---|---|---|
| `profiles` | own row only | ✗ | ✗ | ✗ | all | ✗ | ✓ | ✗ |
| `products` | ✓ all | ✗ | ✗ | ✗ | ✓ all | ✓ | ✓ | ✓ |
| `inventory` | ✓ all | ✗ | ✗ | ✗ | ✓ all | ✓ | ✓ | ✓ |
| `commitments` | own rows only | ✗ | ✗ | ✗ | all | ✗ | ✗ | ✗ |
| `app_settings` | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `inventory_sync_runs` | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `v_inventory` (view) | ✓ (security_invoker) | n/a | n/a | n/a | ✓ | n/a | n/a | n/a |

`anon` has no row on this table at all: no policies, no grants.

---

## 4. `0012_grants.sql` — grants are the other half of the gate

RLS alone is not sufficient. Supabase's default privileges grant `anon` and `authenticated`
broad access to new tables in `public`, and a policy is only consulted when the underlying
grant exists. Making the grants explicit is what makes the policy set actually describe
reality.

```sql
-- Schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Start from nothing for the two client-facing roles.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- anon gets nothing back. An unauthenticated caller with the anon key can read no
-- application data whatsoever.

-- authenticated: the minimum the app needs. Row visibility is then narrowed by RLS.
GRANT SELECT                 ON public.profiles            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory   TO authenticated;
GRANT SELECT                 ON public.commitments         TO authenticated;
GRANT SELECT, UPDATE         ON public.app_settings        TO authenticated;
GRANT SELECT                 ON public.inventory_sync_runs TO authenticated;
GRANT SELECT                 ON public.v_inventory         TO authenticated;

-- UPDATE on profiles is granted so the admin UPDATE policy is reachable at all.
GRANT UPDATE                 ON public.profiles            TO authenticated;

-- Functions. EXECUTE is revoked from PUBLIC first, because functions are granted to
-- PUBLIC by default -- the most commonly missed line in a Supabase hardening pass.
REVOKE EXECUTE ON FUNCTION public.record_commitment(text, integer, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb)                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ensure_profile()                             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pending_commitment_totals()                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.app_role()                                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin()                                   FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_commitment(text, integer, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb)
  TO authenticated, service_role;   -- guarded internally by is_admin(); anon cannot reach it
GRANT EXECUTE ON FUNCTION public.ensure_profile()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.pending_commitment_totals()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_role()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin()  TO authenticated, service_role;

-- Trigger functions. Postgres refuses a direct call, so this is hygiene rather than a live
-- hole -- but a complete revoke list is what a pen test checks.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                 FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.enforce_commitment_invariants()   FROM PUBLIC, anon;

-- Anything created LATER BY THIS ROLE defaults to nothing for the client roles. The explicit
-- FOR ROLE keeps the statement from being silently a no-op.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon;
```

**The pairing, corrected 2026-08-19.** This paragraph used to say that `apply_inventory_sync`
permits a NULL `auth.uid()` and that the branch "is only sound because `EXECUTE` is revoked from
`anon`". That is no longer true, and a false note is worse than none.

`0010`'s role guard is **fail-closed on its own**. It denies by default and admits only
`COALESCE(public.is_admin(), false)` or `COALESCE(auth.role(), '') = 'service_role'`. A NULL-uid
anonymous caller is refused with `KY003` by the function itself, with or without the revoke. The
old form was a **two-file** property, and manual migration application leaves a real window
between pasting `0010` and pasting `0012` in which the database sat fail-open.

**The revoke stays.** It is now defence in depth rather than the only control, and a future
change granting `anon` `EXECUTE` would no longer open the guard — but it must still not be made.
**Both halves stay.** Assertion `4.13` proves the guard independently of the grant: locally it
grants `anon` `EXECUTE` on a disposable database and asserts `KY003` anyway; on the hosted path
it is a `STATIC` source check, because granting `anon` `EXECUTE` on a live project to prove a
guard is a real privilege change.

**Two grant fixes in the same pass.** `ALTER DEFAULT PRIVILEGES` without `FOR ROLE` applies only
to objects created by the *current* role, so the two original lines were near-no-ops; they are
now scoped `FOR ROLE postgres`. `SEQUENCES` was missing entirely, and `FUNCTIONS` is now revoked
from `PUBLIC` as well as `anon`, because functions default to `PUBLIC`. `handle_new_user()` and
`enforce_commitment_invariants()` were the two functions missing from the `PUBLIC` revoke list —
`REVOKE ALL ON ALL FUNCTIONS ... FROM anon` covers `anon` but not `PUBLIC`.

---

## Migration numbering summary (0009–0012)

| File | Contents |
|---|---|
| `0009_fn_record_commitment.sql` | `record_commitment()` — `FOR UPDATE` + recompute-inside-lock + `KY001` |
| `0010_fn_apply_inventory_sync.sql` | `apply_inventory_sync()` — match-only retirement, override preservation, run report |
| `0011_rls_policies.sql` | All 15 policies across 6 tables |
| `0012_grants.sql` | Revokes, per-table grants, function EXECUTE grants, default privileges |

Full list `0001`–`0012`; `0001`–`0008` are in `SCHEMA.md`. They are applied in numeric order
by the Human, in one sitting.
