# VERIFICATION — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. How the four required attacks (brief lines 184–205) are executed
against a **real database**, and what each asserts.

**Ferb has no live database credentials and must not be given any.** Everything here runs
against a **local** Postgres that Builder's code stands up from the committed migrations.
Nothing in this document connects to the hosted Supabase project (`rakslwwxduovcqnuercz`).

**Assertions are made against a real database, never against mocks.** A mocked RLS policy
proves nothing; that is the whole point of these four.

---

## 1. Two ways to get a local database

`verify/README.md` documents both. `verify/run-all.mjs` detects which is available and prints
which one it used, because the answer changes what the results mean.

### Path A (preferred) — Supabase CLI + Docker

```
supabase start
supabase db reset      # applies supabase/migrations/*.sql in order, then supabase/seed/*.sql
```

Gives the real thing: the `auth` schema, real `auth.users`, real `auth.uid()`, real
`anon`/`authenticated`/`service_role` roles, and GoTrue. RLS behaves exactly as it will in
production.

**Credential rule for Path A:** the local stack's keys are printed by `supabase status`. The
harness must read them at runtime via `supabase status -o json` and **must never hardcode
them, not even the well-known local-development defaults.** A hardcoded key-shaped string in
the repo fails `scripts/check-no-secrets.sh` and violates the no-secrets rule regardless of
whether it happens to be public. `verify/lib/harness.mjs` owns this lookup.

### Path B (fallback) — plain `psql` against a local Postgres

**This is the most likely place the whole verification effort falls over, so it is planned
explicitly rather than left to Builder to discover.**

Without the Supabase stack there is no `auth` schema, no `auth.users`, no `auth.uid()`, and
none of the three database roles. Every migration would fail on the first foreign key to
`auth.users(id)`.

`verify/shim/00_auth_shim.sql` supplies the minimum, and is applied **before** the migrations:

```sql
-- LOCAL VERIFICATION ONLY. This file lives in verify/shim/ and NOT in supabase/migrations/.
-- It must never be pasted into the hosted SQL editor -- Supabase already provides all of it.

CREATE SCHEMA IF NOT EXISTS auth;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon          NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL
);

-- Mirrors Supabase's real implementation: read the claim the request set, not a session var
-- the application chose. Same signature, same STABLE volatility, same NULL-when-absent
-- behaviour.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;
```

**Constraints this imposes on the migrations, which Builder must respect:**

- Migrations may reference `auth.users`, `auth.uid()`, `auth.jwt()`, `auth.role()` and the
  three roles — and **nothing else** from the Supabase-managed surface. No `auth.email()`,
  no `storage.*`, no `supabase_functions.*`, no `pgjwt`, no `pg_net`.
- The shim is not a migration and never becomes one. `supabase/migrations/` must contain only
  files the Human will paste into the hosted SQL editor.
- `handle_new_user()`'s trigger on `auth.users` works under Path B because the shim creates
  the table locally. Under Path A it works because Supabase permits it. If it fails on the
  hosted project when the Human applies `0002`, `ensure_profile()` is the documented fallback
  (`SCHEMA.md` §2) — that is why it exists.

**How a session "signs in" under Path B.** Exactly how Supabase's own local RLS testing
works:

```sql
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
  -- …the attack…
ROLLBACK;   -- or COMMIT where the test needs the write to persist
```

`SET LOCAL ROLE` is what makes RLS apply; without it the harness runs as the table owner and
every policy is bypassed, which would produce a set of false passes. `verify/lib/harness.mjs`
exposes `asRep(client)` / `asAdmin(client)` / `asAnon(client)` so no test writes those two
lines by hand and forgets one.

**Honest limitation, stated rather than papered over:** under Path B the harness asserts its
own identity by setting the claims GUC directly. That means Path B proves the **policies** are
correct given an identity; it does **not** prove that JWT signing, verification or session
handling are correct — those are GoTrue's job and are exercised only under Path A and by
manual sign-in against the deployed app. `verify/run-all.mjs` prints this caveat in its
output whenever it runs under Path B, so a Path B pass is never mistaken for a stronger claim
than it is.

---

## 2. `verify/00-setup.sql` — deterministic fixtures

Fixed UUIDs so every assertion can name a row, and so a re-run is reproducible.

```sql
-- Two identities. No passwords anywhere: this system uses magic links and has none.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'rep.verify@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'admin.verify@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- Under Path A the trigger has already made these; under Path B it has too (shim table).
-- Promote the second one.
UPDATE public.profiles SET role = 'admin'
 WHERE id = '00000000-0000-4000-8000-000000000002';
```

`example.invalid` is a reserved, non-routable TLD — these addresses cannot receive mail and
cannot be mistaken for a real person's.

The last-unit test SKU is `SEA-9006`, pinned by the seed generator with
`qty_on_hand = 1, qty_committed = 0, qty_incoming = 0` — availability of exactly 1.

---

## 3. Attack 1 — RLS bypass (`verify/01-rls-bypass.mjs`)

**Method.** Connect as `rep` (identity 1) and query directly over SQL, not through the UI.
An admin-session control run confirms the rows actually exist, so that a refusal is
distinguished from an empty table.

Setup: one commitment owned by the rep, one owned by the admin, both created through
`record_commitment()` under the respective identities.

| # | Attempt (as `rep`) | Expected |
|---|---|---|
| 1.1 | `SELECT * FROM commitments` | Returns **only** rows where `rep_id` = rep's uid. The admin's commitment is absent. Row count asserted exactly. |
| 1.2 | `SELECT * FROM commitments WHERE id = '<admin's commitment id>'` | **0 rows.** Naming the row directly does not help. |
| 1.3 | `SELECT * FROM inventory_sync_runs` | **0 rows**, while the admin control run returns ≥ 1. |
| 1.4 | `SELECT * FROM profiles` | Exactly 1 row (own). The admin profile is absent. |
| 1.5 | `UPDATE inventory SET qty_on_hand = 9999 WHERE sku = 'SEA-9006'` | Refused. `42501`. Follow-up read confirms `qty_on_hand` is still 1. |
| 1.6 | `INSERT INTO inventory (...)` | Refused, `42501`. |
| 1.7 | `DELETE FROM inventory WHERE sku = 'SEA-9006'` | Refused / 0 rows affected; follow-up read confirms the row survives. |
| 1.8 | `INSERT INTO commitments (...)` directly, bypassing the RPC | Refused, `42501`. This is the one that would defeat attack 2 if it succeeded. |
| 1.9 | `UPDATE commitments SET state = 'retired' WHERE rep_id = auth.uid()` | Refused, `42501` (no UPDATE policy exists at all). |
| 1.10 | `SELECT * FROM v_inventory` **as `anon`** | Refused — `permission denied for view v_inventory` (`42501`), because `0012` revokes the grant. |
| 1.11 | `SELECT * FROM commitments` **as `anon`** | Refused, `42501`. |
| 1.12 | View-owner bypass check: confirm `v_inventory` has `security_invoker = on` — `SELECT reloptions FROM pg_class WHERE relname = 'v_inventory'` | Contains `security_invoker=true`. A view without it is a full RLS bypass; this asserts the mitigation is actually present rather than assumed. |

**A pass requires demonstrating the refusal.** Every refusal assertion checks the SQLSTATE and
then re-reads the target row to prove nothing changed. "No error and no rows" is not accepted
for the write cases.

---

## 4. Attack 2 — concurrent commitment on the last unit (`verify/02-concurrent-last-unit.mjs`)

Two genuinely concurrent connections via `pg`, on `SEA-9006` (availability exactly 1).

### 4a. Deterministic interleaving — proves serialisation, not luck

```
A: BEGIN
A: SELECT record_commitment('SEA-9006', 1)      -- takes the FOR UPDATE row lock, inserts
   (A does NOT commit yet)
B: BEGIN
B: SELECT record_commitment('SEA-9006', 1)      -- MUST BLOCK on A's row lock
   harness waits 500ms and asserts B's promise is still unsettled   <-- the key assertion
   harness asserts pg_locks shows B waiting on the inventory row
A: COMMIT
B: now proceeds, recomputes pending inside the lock (now sees A's row), and raises
```

Assertions:

1. B's call **did not return** while A's transaction was open. This is the direct evidence of
   serialisation — a naive read-then-write would have returned immediately with a success.
2. B fails with SQLSTATE **`KY001`**, message matching `insufficient availability`.
3. `SELECT count(*) FROM commitments WHERE sku='SEA-9006' AND state='pending'` = **exactly 1**.
4. `SELECT qty_available FROM v_inventory WHERE sku='SEA-9006'` = **0**, never negative.
5. Through the HTTP surface: the same losing call via `POST /api/commitments` returns
   **409** with `{"error":"INSUFFICIENT_AVAILABILITY", …}` — asserting the route handler
   surfaces the database refusal rather than swallowing it into a 500.

### 4b. Stochastic swarm — catches what a fixed interleaving can miss

Reset `SEA-9006` to `qty_on_hand = 1`, then fire **20 connections** calling
`record_commitment('SEA-9006', 1)` simultaneously via `Promise.all`.

Assertions: exactly **1** fulfilled, exactly **19** rejected with `KY001`, exactly 1 pending
commitment row, `qty_available` = 0.

A third variant sets `qty_on_hand = 3` and fires 20 callers: exactly 3 succeed, 17 fail,
`qty_available` = 0. This catches an off-by-one that a 1-unit test would not.

**Failure of this test is a design failure, not a flake.** If it fails, the fix is in
`record_commitment`, not in the test.

---

## 5. Attack 3 — delta survives a stale baseline (`verify/03-stale-baseline.mjs`)

This is the oversell bug the project exists to prevent.

Fixture: `SEA-9007`, `qty_on_hand = 40`, `qty_committed = 10` → `qty_available` = 30.

| Step | Action | Assertion |
|---|---|---|
| 3.1 | As rep: `record_commitment('SEA-9007', 6)` | `qty_available` drops 30 → **24**. `qty_committed_portal` = 6. Commitment state `pending`. |
| 3.2 | Run `apply_inventory_sync` with the **same baseline** (`on_hand 40, committed 10`) and **`matches: []`** — a source that has not caught up | Commitment still **`pending`**. `qty_available` still **24**. `run.commitments_still_pending` = 1. |
| 3.3 | Run the same sync **five more times** | Still `pending`, still 24. No accumulation of syncs retires it. |
| 3.4 | Age the commitment: `UPDATE commitments SET created_at = now() - interval '30 days'` — via a direct owner-connection, since the trigger forbids it for clients; the harness notes it is simulating elapsed time | Still `pending`, still 24. **Elapsed time changes nothing.** |
| 3.5 | Run the sync again after ageing | Still `pending`, still 24. |
| 3.6 | Static assertion on the source: `apply_inventory_sync`'s body contains no `interval`, no `age(`, and no `now() -` in the retirement block | Passes. Guards against a future "helpful" cleanup being added. |
| 3.7 | Attempt the illegal shortcut as owner: `UPDATE commitments SET state='retired' WHERE …` while `pending` | Refused, SQLSTATE **`KY006`**. Even a privileged caller cannot skip the lifecycle. |
| 3.8 | Now sync **with a real match**: baseline `on_hand 40, committed 16` *and* `matches:[{commitment_id, sku, qty:6, location, source_ref:'SO-10241'}]` | Commitment → **`confirmed_in_source`**, `source_ref` set. `qty_committed_portal` back to 0. `qty_available` **still 24** — the figure does not move, because the source absorbed the delta in the same transaction. **No double-count, and no upward blip.** |
| 3.9 | Mismatch case: a fresh pending commitment of qty 6, synced with `matches:[{commitment_id, qty: 5, …}]` | **Not** confirmed. Stays `pending`. Run report contains `match_fields_disagree`. |
| 3.10 | Unknown-commitment case: `matches:[{commitment_id:'<random uuid>'}]` | Run report contains `unknown_commitment`. No commitment altered. |
| 3.11 | Override preservation: sync a row whose `source = 'manual_override'` | Quantities unchanged; `source_payload.last_source_snapshot` populated; `run.overrides_preserved` = 1. Show both numbers, never silently override. |

Step 3.8 is the one most likely to be got subtly wrong, and it is where an implementation that
looks right fails: if the baseline update and the state change were in separate transactions,
`qty_available` would briefly read 30 between them.

---

## 6. Attack 4 — role enforcement is server-side (`verify/04-role-enforcement.mjs`)

Each admin-only action is invoked **directly** as a `rep`, at the layer where the check is
claimed to live. Hiding a button is not access control and is not tested here.

| # | Action, invoked as `rep` | Layer that must refuse | Expected |
|---|---|---|---|
| 4.1 | `UPDATE inventory SET qty_on_hand = …` | RLS policy `inventory_update_admin` | `42501`; row unchanged |
| 4.2 | `INSERT INTO products …` | RLS policy `products_insert_admin` | `42501` |
| 4.3 | `DELETE FROM products …` | RLS policy `products_delete_admin` | `42501`; row survives |
| 4.4 | `UPDATE app_settings SET inventory_authority='portal'` | RLS policy `app_settings_update_admin` | `42501`; still `quickbooks` |
| 4.5 | `SELECT * FROM inventory_sync_runs` | RLS policy `sync_runs_select_admin` | 0 rows |
| 4.6 | `SELECT apply_inventory_sync('{"rows":[]}')` | `SECURITY DEFINER` guard inside the function | **`KY003`**, `admin role required` |
| 4.7 | `UPDATE profiles SET role='admin' WHERE id = auth.uid()` — self-promotion | RLS policy `profiles_update_admin` | `42501`; role still `rep` |
| 4.8 | `INSERT INTO commitments …` directly | Absence of any INSERT policy | `42501` |
| 4.9 | `POST /api/sync` over HTTP with a rep session | Route handler guard + the function guard beneath it | **403**, body `{"error":"FORBIDDEN_ROLE"}` |
| 4.10 | `POST /api/sync` with **no** session | Route handler guard | **401** |
| 4.11 | Same as 4.6 but as `anon` | `EXECUTE` revoked from `anon` (`0012`) | `42501` — the guard's NULL-uid branch is never reached |
| 4.12 | Control: 4.1, 4.4 and 4.6 as `admin` | — | All **succeed**. Proves the tests are testing the role and not a blanket denial. |

4.12 is not optional. Without it, a build that refuses everything for everyone would pass 4.1
through 4.11 and be reported as secure.

**Where the check lives, per admin-only action** — this is the answer to D7 #4:

| Admin-only action | Enforcing layer |
|---|---|
| Edit inventory quantities | RLS `inventory_update_admin` (database) |
| Create/edit/delete products | RLS `products_*_admin` (database) |
| Change `inventory_authority` or thresholds | RLS `app_settings_update_admin` (database) |
| Read sync history | RLS `sync_runs_select_admin` (database) |
| Run an inventory sync | `is_admin()` guard inside `apply_inventory_sync` (`SECURITY DEFINER` function) **and** a `requireAdmin()` guard in `app/api/sync/route.ts`. Two layers; the database one is authoritative. |
| Change a user's role | RLS `profiles_update_admin` (database) |
| Write a commitment row directly | No policy exists for anyone (database) |

The route-handler guards exist to return a clean 403 instead of a 500. They are **not** the
access control. Every one of them has a database-level refusal underneath it, and attacks 4.1
through 4.8 bypass the route handlers entirely to prove it.

---

## 7. `verify/run-all.mjs` — output contract

Runs `00-setup.sql` then attacks 1–4 in order, against a freshly reset local database.
Prints, per attack:

```
ATTACK 2 — Concurrent commitment on the last unit
  Path:   A (supabase start / docker)
  Method: two concurrent pg connections; A holds the FOR UPDATE row lock inside an open
          transaction while B calls record_commitment on the same SKU; B asserted blocked
          for >500ms, then A commits and B is observed to fail. Repeated as a 20-way
          Promise.all swarm on a 1-unit and a 3-unit SKU.
  2a.1 B blocked while A open ........................ PASS
  ...
  RESULT: PASS (9/9 assertions)
```

Exit code 0 only if all four attacks pass. Any failure prints the failing assertion, the
observed SQLSTATE and the expected one.

The summary block restates the Path A/B caveat from §1 verbatim, so the result is never
reported as stronger than the method supports.

`scripts/check-no-secrets.sh` runs separately and is **not** one of the four attacks: it
greps the repo for key-shaped strings (`eyJ`-prefixed JWTs, `sb[a-z]*_`-prefixed keys,
`password`, `secret`, `token` assignments) and fails on any hit outside `.env.example`
variable names.

---

## 8. What cannot be verified in this environment

Stated plainly rather than papered over:

- **Magic-link email delivery.** Requires a real mail send from the hosted project. Only the
  Human can confirm a link arrives and signs in. Not attackable here.
- **The hosted project's actual RLS state.** The migrations are written, not applied. The
  harness proves the *migrations* produce correct policies; it cannot prove the hosted
  database has them until the Human pastes them. The hand-off must say so.
- **Netlify deployment and the public URL.** Deploy is a push, and pushing is a Human action.
- **JWT signing/verification** under Path B only — see §1.
- **Real Web Push.** Out of scope by the brief; nothing to verify.
