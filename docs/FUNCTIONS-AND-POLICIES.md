# FUNCTIONS AND POLICIES — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. Migrations `0009`–`0012`: the sync procedure, every RLS policy as
SQL, and the grant/revoke set — as amended by `0025`.

Tables, types and the availability view are in `SCHEMA.md`. Custom SQLSTATE codes are
defined there.

> **Current state since `0025_quickbooks_sourced_commitments.sql` (3 Oct 2026).** Reps no
> longer record commitments in the portal; "committed" is QuickBooks' quantity on open sales
> orders, delivered by `apply_inventory_sync()`. `record_commitment()` (`0009`) and
> `pending_commitment_totals()` (`0008`) are dropped. `apply_inventory_sync()` applies rows
> only and refuses a non-empty `matches` array with `KY016`. `pin_override_attribution()`
> re-stamps attribution only on a human correction. `commitments` is retained as read-only
> history with client writes revoked, and `inventory` `INSERT` is column-scoped without
> `qty_committed`.

**Migrations are WRITTEN, NEVER APPLIED.**

---

## 1. `0009_fn_record_commitment.sql` — dropped in `0025`

`record_commitment(p_sku, p_qty, p_location, p_note)` was the portal's commitment write path: a
`SECURITY DEFINER` function that took `SELECT … FOR UPDATE` on the `inventory` row, recomputed
pending commitments inside the lock, refused an over-commit with `KY001`, and inserted a
`pending` row into `commitments`. It existed so two reps could not both commit the last unit.

`0025` drops it, with the decision that committed stock comes from QuickBooks sales orders
only. There is no portal write that can race any more, so the lock-ordering argument no longer
applies. A call now fails with `42883` (undefined function) at the database, or `PGRST202`
through PostgREST — assertion `2.4` checks both roles. `KY001` is no longer raised or mapped.

---

## 2. `apply_inventory_sync()` — rows only (current body from `0025`)

Created in `0010`, amended in `0013` (an unchanged row keeps its `updated_at`), and replaced in
`0025`. It is the only path that writes `qty_committed`.

What it does:

- **Role guard, fail closed.** Only an admin (`public.is_admin()`) or `service_role` may call
  it; anyone else gets `KY003`. Both `COALESCE`s are load-bearing — `auth.role()` is NULL
  without a JWT, and `IF NOT (NULL)` would not fire.
- **No commitment matching.** A payload with a non-empty `matches` array is refused with
  `KY016`, so a stale caller fails loudly rather than having its matches silently ignored.
  An absent or empty `matches` is accepted.
- **Ordinary rows** take on-hand, committed, incoming, ETA and source from the payload.
  `updated_at` moves only if one of the quantities or the ETA actually changed, so a no-op
  sync never claims freshness.
- **`manual_override` rows** keep the admin's corrected `qty_on_hand`, `qty_incoming`,
  `incoming_eta`, `source` and attribution, but take `qty_committed` from the source row:
  QuickBooks' committed does not wait for the correction. The source row is recorded in
  `source_payload.last_source_snapshot`.
- **Rows are locked in `(sku, location)` order**, so two concurrent syncs cannot deadlock.
  Nothing else in the schema takes row locks on `inventory` now.
- **The run is recorded** in `inventory_sync_runs`. `commitments_confirmed` and
  `commitments_still_pending` are written as 0; the columns are kept for historical runs.

```sql
CREATE OR REPLACE FUNCTION public.apply_inventory_sync(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id    uuid  := gen_random_uuid();
  v_rows      jsonb := COALESCE(p_payload -> 'rows', '[]'::jsonb);
  v_row       jsonb;
  v_updated   integer := 0;
  v_overrides integer := 0;
  v_rejected  jsonb := '[]'::jsonb;
  v_inv       public.inventory%ROWTYPE;
  v_committed integer;
BEGIN
  IF NOT (
       COALESCE(public.is_admin(), false)
       OR COALESCE(auth.role(), '') = 'service_role'
     ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = 'KY003';
  END IF;

  IF jsonb_typeof(p_payload -> 'matches') = 'array'
     AND jsonb_array_length(p_payload -> 'matches') > 0 THEN
    RAISE EXCEPTION 'commitment matching was removed in 0025; committed comes from the source rows'
      USING ERRCODE = 'KY016';
  END IF;

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

    v_committed := (v_row ->> 'qty_committed')::integer;

    IF v_inv.source = 'manual_override' THEN
      UPDATE public.inventory
      SET qty_committed  = v_committed,
          source_payload = COALESCE(source_payload, '{}'::jsonb)
                           || jsonb_build_object('last_source_snapshot', v_row,
                                                 'last_source_seen_at', now()),
          updated_at     = CASE
                             WHEN v_inv.qty_committed IS DISTINCT FROM v_committed THEN now()
                             ELSE v_inv.updated_at
                           END
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_overrides := v_overrides + 1;
    ELSE
      UPDATE public.inventory
      SET qty_on_hand    = (v_row ->> 'qty_on_hand')::integer,
          qty_committed  = v_committed,
          qty_incoming   = (v_row ->> 'qty_incoming')::integer,
          incoming_eta   = NULLIF(v_row ->> 'incoming_eta', '')::date,
          source         = COALESCE((v_row ->> 'source')::public.inventory_source,
                                    'quickbooks_stub'::public.inventory_source),
          source_payload = v_row,
          updated_at     = CASE
                             WHEN v_inv.qty_on_hand   IS DISTINCT FROM (v_row ->> 'qty_on_hand')::integer
                               OR v_inv.qty_committed IS DISTINCT FROM v_committed
                               OR v_inv.qty_incoming  IS DISTINCT FROM (v_row ->> 'qty_incoming')::integer
                               OR v_inv.incoming_eta  IS DISTINCT FROM NULLIF(v_row ->> 'incoming_eta', '')::date
                             THEN now()
                             ELSE v_inv.updated_at
                           END
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  INSERT INTO public.inventory_sync_runs
    (id, run_by, rows_applied, overrides_preserved,
     commitments_confirmed, commitments_still_pending, report)
  VALUES
    (v_run_id, auth.uid(), v_updated, v_overrides,
     0, 0, jsonb_build_object('rejected', v_rejected));

  RETURN jsonb_build_object(
    'run_id',              v_run_id,
    'rows_applied',        v_updated,
    'overrides_preserved', v_overrides,
    'rejected',            v_rejected
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
  ]
}
```

`qty_committed` is QuickBooks' quantity on open sales orders for that item, as reported by the
inventory adapter (`lib/inventory-source.ts`). The return value is
`{ run_id, rows_applied, overrides_preserved, rejected }`; the sync button reports rows applied
and overrides kept.

### Before `0025`

The `0010` version also processed a `matches` array, moving a named `pending` commitment to
`confirmed_in_source` only on an exact match of id, SKU, location and quantity, and never by
elapsed time. It left override rows entirely untouched apart from the source snapshot. Both
behaviours are gone; the history is in `0010_fn_apply_inventory_sync.sql` and `PLAN.md`.

### Override attribution — `pin_override_attribution()` (`0013`, amended `0025`)

A `BEFORE INSERT OR UPDATE` trigger on `inventory` stamps `override_by = auth.uid()` and
`override_at = now()` on an override row, so attribution cannot be forged. Since `0025` it
stamps only on a human correction: an `INSERT` of an override row, a row becoming an override,
or a change to `qty_on_hand`, `qty_incoming`, `incoming_eta` or `override_note`. Any other
update of an override row — including a sync refreshing `qty_committed`, and an
attribution-only update — has `override_by` and `override_at` forced back to their old values.
Without this, a sync run by admin B would re-credit admin A's correction to B. A NULL
`auth.uid()` (`service_role`, the local harness) leaves the values as supplied. Assertions `2.8`
and `2.8b` cover both halves.

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

### `commitments` — one policy, deliberately (read-only history since `0025`)

```sql
-- A rep reads their own commitments and nobody else's. An admin reads all.
-- This is the predicate attack 1 targets directly.
CREATE POLICY commitments_select_own_or_admin ON public.commitments
  FOR SELECT TO authenticated
  USING (rep_id = auth.uid() OR public.is_admin());
```

**There is deliberately no INSERT, UPDATE or DELETE policy on `commitments`, for any role,
including admin.**

Originally every write went through `record_commitment()`, so a direct write would have
skipped its availability check. Since `0025` there is no write path at all: the table is kept
as history of the commitments reps recorded before the decision, and nothing reads it to
compute availability. `0025` also revokes `INSERT`, `UPDATE` and `DELETE` from `PUBLIC`,
`anon` and `authenticated`, so the refusal no longer rests on RLS alone.

Direct `INSERT`/`UPDATE`/`DELETE` from any client therefore fails with SQLSTATE `42501`
(`permission denied`). Assertion `2.5` checks all three verbs for `rep` and `admin`; attacks 1
and 4 assert the same refusal from their own directions — this is not a privilege the admin
role has either.

### `app_settings`

```sql
-- Every signed-in user must read the thresholds to render the list. (The comment in 0011 also
-- names inventory_authority; since 0025 that column is pinned to 'quickbooks' and not read.)
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
| `inventory` | ✓ all | ✗ | ✗ | ✗ | ✓ all | ✓ (not `qty_committed`) | ✓ (not `qty_committed`) | ✓ |
| `commitments` (history) | own rows only | ✗ | ✗ | ✗ | all | ✗ | ✗ | ✗ |
| `app_settings` | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `inventory_sync_runs` | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `v_inventory` (view) | ✓ (security_invoker) | n/a | n/a | n/a | ✓ | n/a | n/a | n/a |

`anon` has no row on this table at all: no policies, no grants. The `inventory` admin `INSERT`
and `UPDATE` grants are column-scoped (`UPDATE` since `0013`, `INSERT` since `0025`), so
`qty_committed` is writable only by `apply_inventory_sync()`; a portal-added line starts at
committed 0 until the next sync (assertion `2.9`).

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

**Since `0025`.** The `record_commitment` and `pending_commitment_totals` lines above refer to
functions that no longer exist; they are kept here because this is the `0012` file as written.
`0025` re-asserts the `apply_inventory_sync` grant after replacing the body, revokes
`INSERT`/`UPDATE`/`DELETE` on `commitments` from `PUBLIC`, `anon` and `authenticated`, and
replaces the table-wide `INSERT` on `inventory` with a column list that omits `qty_committed`.

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
| `0009_fn_record_commitment.sql` | `record_commitment()` — `FOR UPDATE` + recompute-inside-lock + `KY001` (dropped in `0025`) |
| `0010_fn_apply_inventory_sync.sql` | `apply_inventory_sync()` — match-only retirement, override preservation, run report (replaced in `0025`: rows only) |
| `0011_rls_policies.sql` | All 15 policies across 6 tables |
| `0012_grants.sql` | Revokes, per-table grants, function EXECUTE grants, default privileges |

`0001`–`0008` are in `SCHEMA.md`. The full set is now `0001`–`0025`, applied in numeric order
by the Human; `0025_quickbooks_sourced_commitments.sql` is the migration this document's
current-state notes refer to.
