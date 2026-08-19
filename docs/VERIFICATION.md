# VERIFICATION — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. How the four required attacks (brief lines 184–205) are executed
against a **real database**, and what each asserts.

**REVISED 2026-08-19 — the verification tooling now targets the hosted project.** The
statement this document previously opened with ("Ferb has no live database credentials and
must not be given any") was true when written and stopped being true when the Human supplied
a hosted Supabase project. `npm run verify` runs the four attacks against
`rakslwwxduovcqnuercz` over HTTPS, using real GoTrue-issued sessions. The embedded-Postgres
path survives as `npm run verify:local`, demoted and relabelled — §1 and §7 below.

**Assertions are made against a real database, never against mocks.** A mocked RLS policy
proves nothing; that is the whole point of these four.

**Never print PASS for anything not actually executed.** Every assertion ends as `PASS`,
`FAIL`, `STATIC` (a labelled migration-source check) or `NOT EXECUTED` with a printed reason.
There is no fifth state and no fallback between them. Totals are computed from what actually
ran; no expected count is hard-coded anywhere.

---

## 1. How the harness reaches a database

### The hosted path — `npm run verify` (the default, and the one that matters)

HTTPS only. There is no `SUPABASE_DB_URL` and no `DATABASE_URL`: a Supabase direct or pooler
connection string embeds the database password, and the credential rule forbids accepting a
password. No `pg` client exists anywhere on this path.

| Channel | Used for |
|---|---|
| PostgREST `/rest/v1/…` | table reads, filtered writes, refusal SQLSTATEs |
| PostgREST `/rest/v1/rpc/…` | `record_commitment`, `apply_inventory_sync` |
| GoTrue `/auth/v1/…` | admin user creation, magic links, OTP exchange, real signed JWTs |
| the running app over HTTP | `POST /api/commitments`, `POST /api/sync`, only when `PORTAL_BASE_URL` is set |

Three consequences drive the assertion classification in §3–§6:

1. **Each request is its own transaction.** No `BEGIN`, no lock held across statements, no
   `SET LOCAL ROLE`. Anything needing a transaction to stay open is unreachable.
2. **`pg_catalog` is not exposed.** `pg_class`, `pg_locks`, `pg_stat_activity`,
   `pg_get_functiondef`, `pg_blocking_pids` are unreachable.
3. **There is no rollback — every request commits.** Which is why every hosted write is
   confined to the harness-owned `KYV-` / `location = 'kyv-verify'` namespace, and
   `app_settings` is only ever written back to its own current value. No `SEA-*` row is
   mutated and the demo delta is read-only. `verify/README.md` documents the fixtures and the
   exact teardown order.

**Identity is real.** `admin.createUser` → service-role profile upsert →
`admin.generateLink({ type: 'magiclink' })` → `properties.hashed_token` → `verifyOtp` on a
separate anon client → a session carrying a real GoTrue-signed JWT. No email is sent and no
password is ever set. That is the thing embedded Postgres cannot supply and the entire point
of this pass.

**No silent fallback.** Missing configuration or an unreachable endpoint prints
`NOT EXECUTED — no Supabase configuration` per affected attack and exits non-zero. A missing
schema is a *different* verdict, `NOT EXECUTED — schema not applied`, because the two send the
reader to different places. `verify/preflight.mjs` is read-only, creates nothing, and
distinguishes both from `seed not applied`, `demo delta not applied, run order violated` and
`test identities not provisioned`.

### The local path — `npm run verify:local` (demoted, kept, relabelled)

Reachable only by asking for it by name. `npm run verify` never selects it and never falls
back to it.

```
npm run verify:local                                               # ephemeral embedded Postgres
VERIFY_DATABASE_URL=postgresql://…@127.0.0.1:5432/postgres npm run verify:local
```

Without the Supabase stack there is no `auth` schema, no `auth.users`, no `auth.uid()` and
none of the three roles, so every migration would fail on the first foreign key to
`auth.users(id)`. `verify/shim/00_auth_shim.sql` supplies the minimum and is applied **before**
the migrations. It is **not** a migration and must never be pasted into the hosted SQL editor
— `supabase/migrations/` contains only files a Human will paste.

**The Supabase-CLI / docker branch has been deleted.** There is no supabase CLI in this
environment, and a detection branch that can never fire is how a future reader concludes the
option exists.

**How a session "signs in" on this path:**

```sql
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
  -- …the attack…
ROLLBACK;   -- or COMMIT where the test needs the write to persist
```

`SET LOCAL ROLE` is what makes RLS apply; without it the harness runs as the table owner and
every policy is bypassed, which would produce a set of false passes.

**Scope statement, printed verbatim in the banner and again in the summary:**

```
  SCOPE: POLICY LOGIC ONLY.
  This run exercises RLS policy logic, function guards and concurrency control against an
  ephemeral local PostgreSQL server. It sets request.jwt.claims directly.
  It does NOT cover: identity issuance, JWT signing, JWT verification, PostgREST request
  handling, or session handling. Those are GoTrue's and PostgREST's job and are exercised
  only by `npm run verify` against the configured hosted project.
  A pass here must never be reported as a claim about the hosted project.
```

**The loopback guard.** `bootstrap()` in `verify/lib/harness.mjs` opens with
`DROP SCHEMA IF EXISTS public CASCADE`. It refuses to issue a single statement unless the
connection URL resolves to a loopback host (127.0.0.0/8, `localhost`, `::1`), and it throws
before the first query rather than warning after it. Nothing under `verify/hosted/**` imports
that module, and the module graph of `verify/run-all.mjs` contains neither it, nor `pg`, nor
`embedded-postgres`.

---

## 2. Fixtures and identities

### The hosted path

Two identities, minted through GoTrue with real signed JWTs, no email, no password:
`rep.verify@example.invalid` and `admin.verify@example.invalid`. `example.invalid` is a
reserved, non-routable TLD — those addresses cannot receive mail and cannot be mistaken for a
person's. `npm run verify:identities` creates them; `npm run verify:identities:remove` removes
them and everything else the harness wrote.

Fixture data lives entirely in the `KYV-` / `location = 'kyv-verify'` namespace
(`KYV-0001`…`KYV-0007`; the SKU shape is forced by `products_sku_format`, which constrains
every sku to `^[A-Z]{3}-[0-9]{4}$`). `verify/README.md` carries the table of what each one is
for, what a run writes, and the FK-ordered teardown.

**`npm run verify:identities` refuses to run if the demo delta is not yet applied.** That is
not a convenience check: `supabase/seed/0003_seed_demo_delta.sql` binds to the earliest `rep`
profile by `created_at`, and no-ops entirely if **any** commitment row exists anywhere — its
guard is `IF EXISTS (SELECT 1 FROM public.commitments)`, unscoped by sku or location. So the
first commitment this harness writes, even at `location = 'kyv-verify'` on a `KYV-` sku, would
suppress `0003` permanently. The canonical order is: **provision and sign in the real rep →
paste `supabase/seed/0003_seed_demo_delta.sql` → only then create test identities and run the
harness.** The detector is a positive probe for the demo-delta row itself, not a bare
commitment count — a count alone waves through the worse state where unrelated commitments
exist but `0003` never ran.

### The local path — `verify/00-setup.sql`

Fixed UUIDs so every assertion can name a row, and so a re-run is reproducible.

```sql
-- Two identities. No passwords anywhere: this system uses magic links and has none.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'rep.verify@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'admin.verify@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- The shim's auth.users table lets the profile trigger fire; this is belt and braces.
-- Promote the second one.
UPDATE public.profiles SET role = 'admin'
 WHERE id = '00000000-0000-4000-8000-000000000002';
```

`example.invalid` is a reserved, non-routable TLD — these addresses cannot receive mail and
cannot be mistaken for a real person's.

The last-unit test SKU is `SEA-9006`, pinned by the seed generator with
`qty_on_hand = 1, qty_committed = 0, qty_incoming = 0` — availability of exactly 1.

---

## 3. Attack 1 — RLS bypass

`verify/hosted/01-rls-bypass.mjs` (hosted) and `verify/01-rls-bypass.mjs` (local).

> **Hosted:** 16 of the 17 assertions run live over PostgREST against real GoTrue sessions.
> `1.12` is a labelled **STATIC** check of `supabase/migrations/0008_inventory_view.sql`,
> because `pg_class` is not exposed; no live proxy for it exists over this channel and none is
> invented. Every write targets `KYV-0001`/`KYV-0002`/`KYV-0003` at `location = 'kyv-verify'`
> — the `SEA-*` SKUs named in the table below are the local path's fixtures and are read-only
> to the hosted harness.

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

## 4. Attack 2 — concurrent commitment on the last unit

`verify/hosted/02-concurrent-last-unit.mjs` (hosted) and `verify/02-concurrent-last-unit.mjs`
(local).

> **Hosted:** the swarm (4b below) runs live as 20 unawaited HTTPS requests to the
> `record_commitment` RPC on `KYV-0004` and `KYV-0005`, with a new assertion `2b.0` that
> records send and first-response timestamps and asserts the requests genuinely overlapped,
> and a new `2b.2b` that asserts every refusal's message. The deterministic interleaving (4a)
> is `NOT EXECUTED` against hosted — PostgREST has one transaction per request and no
> `pg_locks` — and runs only under `verify:local`.
>
> **The residual gap, which must never be glossed:** the hosted swarm proves the **outcome**
> is correctly serialised. It does not provide direct evidence of **blocking**. The honest
> line, which the runner prints: *serialisation outcome verified against hosted; blocking
> behaviour verified only under verify:local*.

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

## 5. Attack 3 — delta survives a stale baseline

`verify/hosted/03-stale-baseline.mjs` (hosted) and `verify/03-stale-baseline.mjs` (local).

> **Hosted:** the fixture is `KYV-0006` at `location = 'kyv-verify'`, same 40/10/30 shape.
> Steps 3.4/3.5 (ageing) are `NOT EXECUTED` — they need `ALTER TABLE … DISABLE TRIGGER`, which
> is DDL and unreachable. Step 3.6 is a **STATIC** grep of the migration source, since
> `pg_get_functiondef` is not exposed. Steps 3.4a and 3.7 attack the immutability guard with a
> service-role `PATCH`; if that returns `42501` rather than `KY006` the harness reports a
> **missing grant**, not a broken trigger, because those are different findings.
>
> **`commitments_still_pending` is project-wide, not payload-scoped**
> (`0010_fn_apply_inventory_sync.sql:148` counts every pending commitment, unfiltered), so on
> hosted the `3.2c` assertion is a **delta** against a count read immediately beforehand, not
> the absolute `= 1` the local path can rely on. `commitments_confirmed`, `rows_applied` and
> `overrides_preserved` count only the call's own work and stay absolute.

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

## 6. Attack 4 — role enforcement is server-side

`verify/hosted/04-role-enforcement.mjs` (hosted) and `verify/04-role-enforcement.mjs` (local).

> **Hosted:** all 17 assertions run live, two of them (4.9, 4.10) conditional on
> `PORTAL_BASE_URL` being set and on the app accepting the harness-minted session. Writes
> target `KYV-0001` and `KYV-0002`, never `SEA-9007`.
>
> **4.12b** reads `inventory_authority` and writes **that same value** back, asserting 1 row
> affected. `app_settings` is a singleton with no disposable copy, and over PostgREST the
> original `SET inventory_authority = 'portal'` would commit and flip the live portal's
> authority mode. The affected-row count is 1 either way, so the policy is proven exactly as
> strongly; the `WHERE` clause stays identical to 4.4's, which is the evidential point.
>
> **4.10** is stated in the table below as "401". `middleware.ts` matches `/api/*` and
> redirects an unauthenticated request to `/login` **before** the route handler runs, so the
> route's own 401 is never reached. That redirect is the refusal. The hosted assertion accepts
> either form, prints which it observed, and corroborates it by asserting that no
> `inventory_sync_runs` row appeared.

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

## 7. Output contract

`npm run verify` prints, in order: a banner naming the channel; a **booleans-only**
configuration block; a read-only preflight; then each attack; then a summary.

The configuration block is `set` / `unset` and the project ref, and nothing else. **Never a
fragment, prefix, suffix, length, character count, hash, checksum or masked form of any
value** — a length is a fingerprint and so is a hash. `scripts/check-no-secrets.sh` enforces
this mechanically: it fails on any line in `verify/` or `scripts/` that both writes to stdout
and reads `process.env`.

```
CONFIGURATION
  NEXT_PUBLIC_SUPABASE_URL .......... set
  NEXT_PUBLIC_SUPABASE_ANON_KEY ..... set
  SUPABASE_SERVICE_ROLE_KEY ......... set
  PORTAL_BASE_URL ................... unset
  project ref ....................... rakslwwxduovcqnuercz
```

Per attack:

```
ATTACK 2 — Concurrent commitment on the last unit
  Target:  hosted Supabase project rakslwwxduovcqnuercz (PostgREST + GoTrue over HTTPS)
  Method: 20 unawaited HTTPS requests to the record_commitment RPC …
  2a.0 KYV-0004 starts with availability of exactly 1 ........ PASS
  2a.2 B is still blocked 500ms later while A holds the lock ... NOT EXECUTED
       ↳ PostgREST has no open transactions — …  Runs under `npm run verify:local`.
  2b.1 20-way swarm on 1 unit: exactly 1 succeeds ............ PASS
  1.12 v_inventory carries security_invoker .................. STATIC
       ↳ STATIC — asserts the migration source, not the deployed view. …
  RESULT: PASS (14/14 executed, 9 NOT EXECUTED)
  NOTE:   Serialisation outcome verified against hosted; blocking behaviour verified only
          under verify:local.
```

The summary then lists **every** `NOT EXECUTED` assertion with its reason and **every**
`STATIC` assertion with the note that it asserts migration source rather than deployed state.

**No assertion count appears anywhere in this document, and none is hard-coded in the
harness.** Totals are computed from what actually ran. A figure from a previous run against a
different target is not a result.

Exit code is 0 only if nothing failed. A `NOT EXECUTED` is never counted as a pass. Missing
configuration, an unreachable endpoint, an unapplied schema, an unapplied seed, a violated run
order or absent test identities each abort the run with their own verdict string and a
non-zero exit.

`scripts/check-no-secrets.sh` runs separately and is **not** one of the four attacks: it greps
the repo for key-shaped strings (`eyJ`-prefixed JWTs, `sb[a-z]*_`-prefixed keys, credential
assignments), for a service-role key exposed via a `NEXT_PUBLIC_` prefix, for committed dotenv
files, and for any environment value reaching stdout.

---

## 8. What cannot be verified in this environment

Stated plainly rather than papered over. Note that one bullet has **inverted** since the
previous revision.

- **Magic-link email delivery.** Still unverifiable, and now for a sharper reason: the harness
  bypasses email *by design* — `generateLink` plus `verifyOtp` is what makes unattended
  verification possible at all — so it proves nothing about whether a link actually reaches an
  inbox. Only a Human signing in can confirm that.
- **The hosted project's actual RLS state — NO LONGER ON THIS LIST.** It was unverifiable when
  the harness could only reach a local database. It becomes verifiable the moment the Human
  applies migrations 0001–0012 and runs `npm run verify`, which is what this tooling now
  exists to do. Until they are applied, the preflight reports
  `NOT EXECUTED — schema not applied` rather than claiming anything.
- **Raw-SQL, open-transaction and `pg_catalog` assertions against hosted.** PostgREST gives one
  transaction per request and no catalog access, so `2a.1`–`2a.9`, `2b.10`, and the ageing
  assertions `3.4`, `3.4b`, `3.5`, `3.5b`, `3.5c` (which need `ALTER TABLE … DISABLE TRIGGER`)
  are reported `NOT EXECUTED` with the reason. They all run under `npm run verify:local`.
- **Deployed function and view bodies.** `pg_get_functiondef` and `pg_class` are not exposed
  over PostgREST, so `1.12` and the `3.6` family are `STATIC` checks of the migration source.
  `verify:local` inspects a deployed object — but a locally deployed one.
- **Blocking, as distinct from serialisation.** The hosted swarm proves exactly one caller
  wins; it cannot show a caller *waiting*. Preserved under `verify:local` and printed as a
  caveat, never glossed.
- **JWT signing and verification under `verify:local`.** That path sets the claims GUC
  directly. It is now covered against hosted, which is the point of this revision.
- **Netlify deployment and the public URL.** Deploy is a push, and pushing is a Human action.
- **Real Web Push.** Out of scope by the brief; nothing to verify.
