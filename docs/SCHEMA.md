# SCHEMA — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. Migrations `0001`–`0008`: types, tables, constraints, indexes, and
the inventory view. Functions, RLS policies and grants are in `FUNCTIONS-AND-POLICIES.md`.

**Migrations are WRITTEN, NEVER APPLIED.** Builder writes these files into
`supabase/migrations/` and stops. Nothing in this build connects to the hosted Supabase
project (`rakslwwxduovcqnuercz`). The Human pastes each file, in numeric order, into the SQL
editor so a person reads every schema change.

---

## 0. Design rules that drive the shape

1. **Store the components, derive the answer.** `qty_on_hand`, `qty_committed`,
   `qty_incoming` are stored. `available` is never stored as an independent blended figure.
2. **`location` exists from day one.** The stub writes `location = 'default'` on every row.
   No location UI in this run (D4 #3).
3. **`source` and `source_payload jsonb` on `inventory`**, and `source` is surfaced in the
   UI. A rep seeing whether a number came from QuickBooks or a manual override is a trust
   feature and makes the eventual cutover observable rather than silent.
4. **`products` and `inventory` are separate tables.** Catalogue facts (name, category) are
   not per-location. `inventory` is keyed `(sku, location)`.
5. **RLS is enabled in the same migration that creates the table.** A table is never created
   without it. RLS-on-with-no-policies is deny-all, which is the safe intermediate state
   between migration 000n and 0011.
6. **`FORCE ROW LEVEL SECURITY` is NOT used, deliberately.** The `SECURITY DEFINER`
   functions run as `postgres`, which also owns the tables; a table owner bypasses RLS
   unless FORCE is set. That bypass is exactly what lets `record_commitment` insert a row
   that no client-facing policy permits. Setting FORCE would break the concurrency-controlled
   write path. Do not add it.

### Custom SQLSTATE codes used throughout

Postgres permits user-defined SQLSTATEs made of digits and upper-case ASCII letters. These
are branched on by name in `lib/errors.ts`, never by message text.

| Code | Meaning | HTTP |
|---|---|---|
| `KY001` | INSUFFICIENT_AVAILABILITY — lost the race, or asked for more than exists | 409 |
| `KY002` | NOT_AUTHENTICATED | 401 |
| `KY003` | FORBIDDEN_ROLE — admin required | 403 |
| `KY004` | INVALID_INPUT | 400 |
| `KY005` | UNKNOWN_SKU_LOCATION | 404 |
| `KY006` | ILLEGAL_COMMITMENT_TRANSITION | 409 |

---

## 1. `0001_extensions_and_enums.sql`

```sql
-- gen_random_uuid() is built in on PG13+; Supabase also ships pgcrypto. No extension needed.

-- Enums rather than text+CHECK: the value sets are fixed by the brief, and an enum makes an
-- out-of-band state literally unrepresentable rather than merely rejected.
CREATE TYPE public.app_role            AS ENUM ('rep', 'admin');
CREATE TYPE public.commitment_state    AS ENUM ('pending', 'confirmed_in_source', 'retired');
CREATE TYPE public.inventory_source    AS ENUM ('quickbooks', 'quickbooks_stub', 'manual_override');
CREATE TYPE public.inventory_authority AS ENUM ('quickbooks', 'portal');
```

`quickbooks` and `quickbooks_stub` are distinct values on purpose: the stub must never claim
to be the real integration. The UI labels them "QuickBooks" and "QuickBooks (stub)". When
the real integration lands it writes `quickbooks` and the change is visible to every rep.

---

## 2. `0002_profiles_and_role_helpers.sql`

```sql
CREATE TABLE public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      text NOT NULL,
  role       public.app_role NOT NULL DEFAULT 'rep',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE INDEX profiles_role_idx ON public.profiles (role);
```

### Where role lives, and how a policy reads it

Role lives in `public.profiles.role`, in the database. It is **never** read from anything the
client sends: not a request body, not a header, not `localStorage`, not a query parameter,
and not a custom JWT claim. The only trusted input is `auth.uid()`, which PostgREST derives
from the Supabase-signed JWT and which the client cannot forge.

A custom JWT claim was considered and rejected for this run: it would require an auth hook
that is not otherwise in scope, and it goes stale on a role change until the token refreshes.
A table read is correct and cheap at this scale.

```sql
-- SECURITY DEFINER is REQUIRED here. This function is called from inside the RLS policies
-- on public.profiles itself. A SECURITY INVOKER function would re-enter those policies and
-- recurse (error 42P17: infinite recursion detected in policy). This is the single most
-- common Supabase RLS footgun and the reason this function exists at all.
CREATE OR REPLACE FUNCTION public.app_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.role FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(public.app_role() = 'admin', false);
$$;
```

`auth.uid()` works correctly inside a `SECURITY DEFINER` function: it reads the
`request.jwt.claims` GUC that PostgREST sets per request, and `SECURITY DEFINER` changes the
executing role, not the GUC. This is worth knowing because the opposite is frequently assumed.

### Profile provisioning

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'rep')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

```sql
-- Belt and braces. Some Supabase projects refuse a trigger on auth.users depending on
-- project age and grants. If the CREATE TRIGGER above fails when the Human applies it, this
-- is the fallback: app/auth/callback/route.ts calls it once after a successful verify.
--
-- It is idempotent and CANNOT downgrade an existing admin, because it is ON CONFLICT DO
-- NOTHING and never DO UPDATE. Writing "ON CONFLICT (id) DO UPDATE SET role = 'rep'" here
-- would be a privilege-downgrade bug and a trivial denial-of-service against admins.
-- Do not write one.
CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'KY002';
  END IF;

  INSERT INTO public.profiles (id, email, role)
  SELECT u.id, u.email, 'rep' FROM auth.users u WHERE u.id = v_uid
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid;
  RETURN v_row;
END;
$$;
```

**Role assignment.** Everyone provisions as `rep`. Admins are promoted by the Human running
`UPDATE public.profiles SET role = 'admin' WHERE email = '…';` in the SQL editor. There is no
self-service path to `admin` anywhere in the application, and no `role` value is ever
accepted from a request. `README.md` documents this.

---

## 3. `0003_products.sql`

```sql
CREATE TABLE public.products (
  sku                 text PRIMARY KEY,
  name                text NOT NULL,
  category            text NOT NULL,
  uom                 text NOT NULL DEFAULT 'EA',
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_sku_format    CHECK (sku ~ '^[A-Z]{3}-[0-9]{4}$'),
  CONSTRAINT products_name_nonempty CHECK (length(btrim(name)) > 0)
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE INDEX products_category_idx ON public.products (category);
CREATE INDEX products_name_idx     ON public.products (lower(name));
```

`low_stock_threshold` is per-product because "low" means different things for a 4-unit
conference table and a 400-unit stacking chair. The seed generator sets it per product;
`app_settings.low_stock_default` supplies the default for rows that do not set one.

No `pg_trgm` index: the catalogue is ~96 rows and search runs client-side (see `PLAN.md` §
"Search and filter"). Adding one later is a one-line migration.

---

## 4. `0004_inventory.sql`

```sql
CREATE TABLE public.inventory (
  sku            text NOT NULL REFERENCES public.products (sku) ON DELETE CASCADE,
  location       text NOT NULL DEFAULT 'default',
  qty_on_hand    integer NOT NULL DEFAULT 0,
  qty_committed  integer NOT NULL DEFAULT 0 CHECK (qty_committed >= 0),
  qty_incoming   integer NOT NULL DEFAULT 0 CHECK (qty_incoming  >= 0),
  incoming_eta   date,
  source         public.inventory_source NOT NULL DEFAULT 'quickbooks_stub',
  source_payload jsonb,
  override_note  text,
  override_by    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  override_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- available FROM THE SOURCE ONLY. The portal delta is applied in the view (§8), never
  -- stored here, because it is a live aggregate over the commitments ledger.
  qty_available_source integer
    GENERATED ALWAYS AS (qty_on_hand - qty_committed) STORED,

  PRIMARY KEY (sku, location),

  CONSTRAINT inventory_incoming_eta_needs_qty
    CHECK (incoming_eta IS NULL OR qty_incoming > 0),

  -- Enforces "overrides are visible as overrides, with who and when" at the database layer
  -- rather than trusting the UI to fill the fields in.
  CONSTRAINT inventory_override_is_attributed
    CHECK (source <> 'manual_override'
           OR (override_note IS NOT NULL AND override_at IS NOT NULL))
);

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

CREATE INDEX inventory_updated_at_idx ON public.inventory (updated_at);
CREATE INDEX inventory_available_idx  ON public.inventory (qty_available_source);
CREATE INDEX inventory_source_idx     ON public.inventory (source);
```

**There is deliberately no `qty_on_hand >= 0` constraint.** QuickBooks can and does report a
negative on-hand figure when invoices outrun receipts. Rejecting real source data at the
constraint layer would make the sync fail on exactly the rows most worth looking at. Negative
on-hand is displayed honestly rather than clamped.

**`override_by` is nullable** because the seed fixture is authored before any admin user
exists. The note and timestamp are not nullable for an override row — the CHECK sees to that.

---

## 5. `0005_commitments.sql` — the delta ledger

Ships in full in this run. Its UI does not (D8 / `PLAN.md` §"Out of scope").

```sql
CREATE TABLE public.commitments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku          text NOT NULL,
  location     text NOT NULL DEFAULT 'default',
  qty          integer NOT NULL CHECK (qty > 0),
  rep_id       uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  state        public.commitment_state NOT NULL DEFAULT 'pending',
  note         text,
  source_ref   text,          -- the source document reference that matched it, once matched
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  retired_at   timestamptz,

  FOREIGN KEY (sku, location)
    REFERENCES public.inventory (sku, location) ON DELETE RESTRICT,

  CONSTRAINT commitments_state_timestamps CHECK (
        (state = 'pending'             AND confirmed_at IS NULL     AND retired_at IS NULL)
     OR (state = 'confirmed_in_source' AND confirmed_at IS NOT NULL AND retired_at IS NULL)
     OR (state = 'retired'             AND confirmed_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

ALTER TABLE public.commitments ENABLE ROW LEVEL SECURITY;

-- Drives the availability aggregate. Partial index: only pending rows reduce available.
CREATE INDEX commitments_pending_idx
  ON public.commitments (sku, location) WHERE state = 'pending';

CREATE INDEX commitments_rep_idx   ON public.commitments (rep_id, created_at DESC);
CREATE INDEX commitments_state_idx ON public.commitments (state, created_at);
```

### Lifecycle semantics — which states reduce `available`

| State | Reduces `available`? | Set by |
|---|---|---|
| `pending` | **Yes.** The portal knows about the sale; the source baseline does not. | `record_commitment()` on insert |
| `confirmed_in_source` | **No.** The synced baseline's own `qty_committed` now includes it; counting it again would double-count. | `apply_inventory_sync()`, on an explicit match only |
| `retired` | No. Terminal archival state. | Nothing in this run. Reachable only from `confirmed_in_source`. |

The transition from `pending` to `confirmed_in_source` and the arrival of the new baseline
happen **in the same transaction** inside `apply_inventory_sync()`. That matters: if they
were separate, there would be a window where neither the ledger nor the baseline counted the
commitment and `available` would briefly jump up — the oversell bug, in miniature.

### The state-transition trigger

This is where "retirement by matching only, never by time" becomes structurally hard rather
than merely intended. The lifecycle is a one-way ratchet with no shortcut from `pending` to
`retired`, so no timer, cron job, or nightly reset can retire a live delta — it would have to
pass through `confirmed_in_source`, which only an explicit match sets.

```sql
CREATE OR REPLACE FUNCTION public.enforce_commitment_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A commitment's identity is immutable. Without this, "retirement" could be faked by
  -- rewriting qty to 0, or the row repointed at a different SKU.
  IF NEW.sku <> OLD.sku
     OR NEW.location   <> OLD.location
     OR NEW.qty        <> OLD.qty
     OR NEW.rep_id     <> OLD.rep_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'commitment % is immutable in sku/location/qty/rep_id/created_at', OLD.id
      USING ERRCODE = 'KY006';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'confirmed_in_source' THEN
    NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
    RETURN NEW;
  END IF;

  IF OLD.state = 'confirmed_in_source' AND NEW.state = 'retired' THEN
    NEW.retired_at := COALESCE(NEW.retired_at, now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal commitment state transition % -> % on commitment %',
                  OLD.state, NEW.state, OLD.id
    USING ERRCODE = 'KY006',
          HINT = 'pending -> confirmed_in_source -> retired only; retirement is by explicit match, never by elapsed time';
END;
$$;

CREATE TRIGGER commitments_enforce_invariants
BEFORE UPDATE ON public.commitments
FOR EACH ROW EXECUTE FUNCTION public.enforce_commitment_invariants();
```

Rejected with `KY006`: `pending → retired`, `confirmed_in_source → pending`,
`retired → anything`, and any edit to sku/location/qty/rep_id/created_at.

There is no `DELETE` policy on `commitments` (see `FUNCTIONS-AND-POLICIES.md`), so deletion
is available only to the table owner and `service_role`, never to an application user.

---

## 6. `0006_app_settings.sql`

```sql
-- Singleton: the boolean primary key with CHECK (id) makes a second row impossible.
CREATE TABLE public.app_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  inventory_authority public.inventory_authority NOT NULL DEFAULT 'quickbooks',
  low_stock_default   integer NOT NULL DEFAULT 5   CHECK (low_stock_default >= 0),
  stale_after_minutes integer NOT NULL DEFAULT 360 CHECK (stale_after_minutes > 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_settings (id) VALUES (true);
```

Ships in `inventory_authority = 'quickbooks'` mode per D4 — show both numbers, never
silently override. `stale_after_minutes = 360` (6 hours) is the concrete "staler than a few
hours" threshold; it lives in the database so it is tunable without a redeploy, and the app
reads it rather than hard-coding it.

---

## 7. `0007_inventory_sync_runs.sql`

```sql
CREATE TABLE public.inventory_sync_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                    timestamptz NOT NULL DEFAULT now(),
  run_by                    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  rows_applied              integer NOT NULL DEFAULT 0,
  overrides_preserved       integer NOT NULL DEFAULT 0,
  commitments_confirmed     integer NOT NULL DEFAULT 0,
  commitments_still_pending integer NOT NULL DEFAULT 0,
  report                    jsonb
);

ALTER TABLE public.inventory_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX inventory_sync_runs_run_at_idx ON public.inventory_sync_runs (run_at DESC);
```

`run_by` is nullable: a `service_role` sync has no `auth.uid()`. This table is
admin-readable only, which gives attack 1 a second forbidden-read target beyond
`commitments`.

---

## 8. `0008_inventory_view.sql` — the availability derivation

Two objects. Read the note on `security_invoker` carefully; getting it wrong in either
direction produces a bug.

```sql
-- The portal delta, aggregated. SECURITY DEFINER is deliberate and load-bearing.
--
-- Reps may read only their OWN commitment rows (RLS, see FUNCTIONS-AND-POLICIES.md). If this
-- aggregate ran as the invoker, every rep would compute a portal delta that counted only
-- their own commitments and would see an availability figure that is too high for everyone
-- else's sales -- which is precisely the oversell bug this project exists to prevent.
--
-- The exposure is deliberate and bounded: this returns a TOTAL per (sku, location) and
-- nothing else. Reps learn how many units are spoken for. They do not learn by whom, when,
-- for what, or in how many separate commitments. Individual rows stay protected by RLS.
CREATE OR REPLACE FUNCTION public.pending_commitment_totals()
RETURNS TABLE (sku text, location text, qty_committed_portal integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.sku, c.location, SUM(c.qty)::integer
  FROM public.commitments c
  WHERE c.state = 'pending'
  GROUP BY c.sku, c.location;
$$;
```

```sql
-- WITH (security_invoker = on) IS MANDATORY.
--
-- A Postgres view runs with the VIEW OWNER's privileges by default. The owner here is
-- postgres, which bypasses RLS -- so a default view over these tables would be a complete
-- RLS bypass reachable with the anon key. This is a known Supabase footgun and attack 1
-- asserts against it explicitly.
--
-- With security_invoker on, the caller's RLS applies to products and inventory (both of
-- which every authenticated user may read anyway), while the commitments aggregate arrives
-- via the SECURITY DEFINER function above. That combination is the whole point.
CREATE VIEW public.v_inventory
WITH (security_invoker = on)
AS
SELECT
  p.sku,
  p.name,
  p.category,
  p.uom,
  p.low_stock_threshold,
  i.location,
  i.qty_on_hand,
  i.qty_committed                                   AS qty_committed_source,
  COALESCE(t.qty_committed_portal, 0)               AS qty_committed_portal,
  i.qty_committed + COALESCE(t.qty_committed_portal, 0) AS qty_committed_total,
  i.qty_available_source,
  i.qty_available_source - COALESCE(t.qty_committed_portal, 0) AS qty_available,
  i.qty_incoming,
  i.incoming_eta,
  i.source,
  i.override_note,
  i.override_at,
  i.override_by,
  i.updated_at
FROM public.products p
JOIN public.inventory i
  ON i.sku = p.sku
LEFT JOIN public.pending_commitment_totals() t
  ON t.sku = i.sku AND t.location = i.location;
```

### The four availability figures, and which one means what

| Column | Definition | Used for |
|---|---|---|
| `qty_on_hand` | source on-hand | components line |
| `qty_committed_source` | committed per the source (QuickBooks) | components line |
| `qty_committed_portal` | sum of `pending` commitments | the advisory delta line |
| `qty_available_source` | `on_hand − committed_source` | primary figure in `quickbooks` mode |
| `qty_available` | `on_hand − committed_source − committed_portal` | primary figure in `portal` mode; **always** drives the status badge |

**`available` is never clamped at zero.** A negative figure is real information — it means
the source reported an on-hand drop below what is already spoken for. Clamping it would hide
exactly the condition a rep needs to see. It renders as a negative number with the
"none available" status treatment.

**The status badge is always computed from `qty_available`, the most conservative figure, in
both authority modes.** Authority mode governs presentation emphasis, not safety. A status
that said "in stock" because QuickBooks had not caught up yet would reintroduce the bug the
project exists to prevent. This is a deliberate decision, recorded in `PLAN.md` §"Assumptions
and decisions" as decision A5.

---

## Migration numbering summary (0001–0008)

| File | Contents |
|---|---|
| `0001_extensions_and_enums.sql` | 4 enum types |
| `0002_profiles_and_role_helpers.sql` | `profiles` + RLS on + `app_role()`, `is_admin()`, `handle_new_user()` + trigger, `ensure_profile()` |
| `0003_products.sql` | `products` + RLS on + 2 indexes |
| `0004_inventory.sql` | `inventory` + generated `qty_available_source` + RLS on + 3 indexes |
| `0005_commitments.sql` | `commitments` + RLS on + 3 indexes + `enforce_commitment_invariants()` trigger |
| `0006_app_settings.sql` | `app_settings` singleton + RLS on + the single row |
| `0007_inventory_sync_runs.sql` | `inventory_sync_runs` + RLS on + 1 index |
| `0008_inventory_view.sql` | `pending_commitment_totals()` + `v_inventory` (security_invoker) |

Continued in `FUNCTIONS-AND-POLICIES.md`: `0009`–`0012`.
