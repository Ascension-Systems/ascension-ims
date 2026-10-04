# VERIFICATION — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. How the required attacks (brief lines 184–205) are executed against
a **real database**, and what each asserts. The brief named four; since `0025` attack 3 is
retired and attacks 1, 2 and 4 run (see the 3 Oct 2026 revision below).

**REVISED 2026-08-19 — the verification tooling now targets the hosted project.** The
statement this document previously opened with ("Ferb has no live database credentials and
must not be given any") was true when written and stopped being true when the Human supplied
a hosted Supabase project. `npm run verify` runs the attacks against
`rakslwwxduovcqnuercz` over HTTPS, using real GoTrue-issued sessions. The embedded-Postgres
path survives as `npm run verify:local`, demoted and relabelled — §1 and §8 below.

**Assertions are made against a real database, never against mocks.** A mocked RLS policy
proves nothing; that is the whole point of these attacks.

**REVISED 3 Oct 2026 — migration `0025`.** Reps no longer record commitments in the portal;
"committed" is QuickBooks' quantity on open sales orders. The two attacks that exercised the
portal commitment ledger no longer have a subject. **Attack 2 is replaced** by "QuickBooks is
the only source of committed" (§4). **Attack 3 is retired** (§5 keeps a short record of why).
Attack 4 and suite 5 keep their numbers, so the suites that run are 1, 2 and 4, plus
regression suite 5.

**Never print PASS for anything not actually executed.** Every assertion ends as `PASS`,
`FAIL`, `STATIC` (a labelled migration-source check) or `NOT EXECUTED` with a printed reason.
There is no fifth state and no fallback between them — `verify/lib/report.mjs` declares those
four and no others. Totals are computed from what actually ran; no expected count is
hard-coded anywhere.

**No count in this document is written by hand.** Every figure describing the assertion
inventory lives in one generated region in §8, produced by `npm run verify:disposition` from
`verify/lib/manifest.mjs` and checked by `npm run check:disposition`. The prose deliberately
carries none, because a prose figure has no mechanism keeping it true: two people counting
this document previously produced two different wrong answers, and neither was reproducible
from anything in the repository.

---

## 1. How the harness reaches a database

### The hosted path — `npm run verify` (the default, and the one that matters)

HTTPS only. There is no `SUPABASE_DB_URL` and no `DATABASE_URL`: a Supabase direct or pooler
connection string embeds the database password, and the credential rule forbids accepting a
password. No `pg` client exists anywhere on this path.

| Channel | Used for |
|---|---|
| PostgREST `/rest/v1/…` | table reads, filtered writes, refusal SQLSTATEs |
| PostgREST `/rest/v1/rpc/…` | `apply_inventory_sync`; `record_commitment` only to assert it no longer exists (`2.4`) |
| GoTrue `/auth/v1/…` | admin user creation, magic links, OTP exchange, real signed JWTs |
| the running app over HTTP | `POST /api/documents` (session probe), `POST /api/sync`, only when `PORTAL_BASE_URL` is set |

Three consequences drive the assertion classification in §3–§6:

1. **Each request is its own transaction.** No `BEGIN`, no lock held across statements, no
   `SET LOCAL ROLE`. Anything needing a transaction to stay open is unreachable.
2. **`pg_catalog` is not exposed.** `pg_class`, `pg_locks`, `pg_stat_activity`,
   `pg_get_functiondef`, `pg_blocking_pids` are unreachable.
3. **There is no rollback — every request commits.** Which is why every hosted write is
   confined to the harness-owned `KYV-` / `location = 'kyv-verify'` namespace, and
   `app_settings` is only ever written back to its own current value. No `SEA-*` row is
   mutated. `verify/README.md` documents the fixtures and the
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
distinguishes both from `seed not applied`, `SEA-9003 not attributed (seed 0003), run order
violated` and `test identities not provisioned`.

### The local path — `npm run verify:local` (demoted, kept, relabelled)

Reachable only by asking for it by name. `npm run verify` never selects it and never falls
back to it.

```
npm run verify:local                                               # ephemeral embedded Postgres
VERIFY_DATABASE_URL=postgresql://…@127.0.0.1:5432/postgres npm run verify:local
```

Without the Supabase stack there is no `auth` schema, no `auth.users`, no `auth.uid()` and
none of the three roles, so every migration would fail on the first foreign key to
`auth.users(id)`. `verify/shim/00_auth_shim.sql` supplies the minimum — including stub
`storage` tables for `0015`/`0023` and stub `cron.schedule`/`cron.unschedule` for `0018` — and
is applied **before** the migrations. The embedded server has no `pg_cron`, so on the local
path only the harness removes `0018`'s `CREATE EXTENSION … pg_cron` and says so in the run
header. It is **not** a migration and must never be pasted into the hosted SQL editor
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
(`KYV-0001`…`KYV-0007`, plus `KYV-0008` created by `2.9`; the SKU shape is forced by `products_sku_format`, which constrains
every sku to `^[A-Z]{3}-[0-9]{4}$`). `verify/README.md` carries the table of what each one is
for, what a run writes, and the FK-ordered teardown.

**`npm run verify:identities` refuses to run until `SEA-9003` is attributed to a real
admin.** `supabase/seed/0003_seed_demo_delta.sql` (filename historical) credits `SEA-9003`'s
seeded override to the **earliest** admin profile by `created_at`. If the verification admin
were created first, it would take that credit, and `SEA-9003` would lose its attribution when
the test identities are removed (`profiles ON DELETE SET NULL`). The canonical order is:
**provision and sign in the real admin → paste `supabase/seed/0003_seed_demo_delta.sql` → only
then run `npm run verify:identities` and the harness.** The detector
(`attributionVerdict` in `verify/hosted/lib/identity.mjs`) reads `SEA-9003.override_by` and
refuses both when it is empty and when it names a test identity. Until `0025` this interlock
probed for a demo rep commitment that `0003` created; `0003` no longer creates one.

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

Attack 2 uses two pinned seed fixtures: `SEA-9006` (`qty_on_hand = 1`), given a committed
figure above its on-hand to produce a negative availability, and `SEA-9007` (40 on hand, 10
committed), the target of a committed-figure sync. `2.8` creates a second admin identity
(`admin2.verify@example.invalid`) so that a sync run by a different admin can be observed.

---

## 3. Attack 1 — RLS bypass

`verify/hosted/01-rls-bypass.mjs` (hosted) and `verify/01-rls-bypass.mjs` (local).

> **Hosted:** the assertions run live over PostgREST against real GoTrue sessions, with one
> exception: `1.12` is a labelled **STATIC** check of the effective `v_inventory` definition
> in the migration source (currently `0025`), because `pg_class` is not exposed; no live
> proxy for it exists over this channel and none is invented. The counts are in the
> disposition block in §8. Every write targets `KYV-0001`/`KYV-0002`/`KYV-0003` at
> `location = 'kyv-verify'` — the `SEA-*` SKUs named in the table below are the local path's
> fixtures and are read-only to the hosted harness.

**Method.** Connect as `rep` (identity 1) and query directly over SQL, not through the UI.
An admin-session control run confirms the rows actually exist, so that a refusal is
distinguished from an empty table.

Setup: one historical commitment row owned by the rep and one owned by the admin, inserted by
the table owner (locally) or `service_role` (hosted). Since `0025` no client identity can write
`commitments`, so the rows cannot be created through the client path; the table is read-only
history, and attack 1 still proves that a rep reads only their own rows of it.

| # | Attempt (as `rep`) | Expected |
|---|---|---|
| 1.1 | `SELECT * FROM commitments` | Returns **only** rows where `rep_id` = rep's uid. The admin's commitment is absent. Row count asserted exactly. |
| 1.2 | `SELECT * FROM commitments WHERE id = '<admin's commitment id>'` | **0 rows.** Naming the row directly does not help. |
| 1.3 | `SELECT * FROM inventory_sync_runs` | **0 rows**, while the admin control run returns ≥ 1. |
| 1.4 | `SELECT * FROM profiles` | Exactly 1 row (own). The admin profile is absent. |
| 1.5 | `UPDATE inventory SET qty_on_hand = 9999 WHERE sku = 'SEA-9006'` | Refused. `42501`. Follow-up read confirms `qty_on_hand` is still 1. |
| 1.6 | `INSERT INTO inventory (...)` | Refused, `42501`. |
| 1.7 | `DELETE FROM inventory WHERE sku = 'SEA-9006'` | Refused / 0 rows affected; follow-up read confirms the row survives. |
| 1.8 | `INSERT INTO commitments (...)` directly | Refused, `42501`. No client write path to `commitments` exists since `0025`. |
| 1.9 | `UPDATE commitments SET state = 'retired' WHERE rep_id = auth.uid()` | Refused, `42501` (no UPDATE policy exists at all). |
| 1.10 | `SELECT * FROM v_inventory` **as `anon`** | Refused — `permission denied for view v_inventory` (`42501`), because `0012` revokes the grant. |
| 1.11 | `SELECT * FROM commitments` **as `anon`** | Refused, `42501`. |
| 1.12 | View-owner bypass check: confirm `v_inventory` has `security_invoker = on` — `SELECT reloptions FROM pg_class WHERE relname = 'v_inventory'` | Contains `security_invoker=true`. A view without it is a full RLS bypass; this asserts the mitigation is actually present rather than assumed. |

**A pass requires demonstrating the refusal.** Every refusal assertion checks the SQLSTATE and
then re-reads the target row to prove nothing changed. "No error and no rows" is not accepted
for the write cases.

---

## 4. Attack 2 — QuickBooks is the only source of committed

`verify/hosted/02-quickbooks-sole-source.mjs` (hosted) and `verify/02-quickbooks-sole-source.mjs`
(local).

Replaces the original attack 2, "concurrent commitment on the last unit", retired with `0025`:
with no portal commitment there is nothing to race. What must hold now is that the figures a
rep reads are QuickBooks' figures, that no client can enter or alter a committed figure, and
that an admin's correction survives a sync without stopping QuickBooks' committed from flowing
in or being re-credited to whoever ran the sync.

**Method.** Figures are read through `v_inventory` in a rep session and compared with an
owner (local) or `service_role` (hosted) read of `inventory`. Syncs are applied through
`apply_inventory_sync` as admin identities. Every forbidden action is issued directly — over SQL
locally, at PostgREST on hosted — and asserted by its SQLSTATE or error code. Attribution is
compared before and after a sync run by a user other than the author.

> **Hosted:** every assertion runs live. Writes are confined to `KYV-0004`, `KYV-0006`,
> `KYV-0007` and `KYV-0008` at `location = 'kyv-verify'`. Two differences from the local path,
> stated rather than hidden: `2.4` also accepts PostgREST's `PGRST202` ("function not found in
> the schema cache"), because over this channel a dropped function is reported by PostgREST;
> and `2.8` has only one admin session, so the override fixture is pre-attributed to the rep by
> `service_role` and the admin runs the sync — the property is the same.

| # | What is done | Expected |
|---|---|---|
| 2.1 | Read every row through `v_inventory` as `rep` | `qty_committed` equals `inventory.qty_committed` on every row; row counts match |
| 2.2 | Same read, with one row's committed set above its on-hand (`SEA-9006` / `KYV-0004`: on hand 1, committed 3) | `qty_available = qty_on_hand − qty_committed` on every row; that row reads **−2**, not clamped |
| 2.3 | Admin sync moving `SEA-9007` / `KYV-0006` to on hand 40, committed 25 | A rep then reads committed **25**, available **15** |
| 2.4 | `record_commitment(...)` as `rep` and as `admin` | Function does not exist: `42883` (local); `PGRST202` or `42883` (hosted) |
| 2.5 | `INSERT`, `UPDATE` and `DELETE` on `commitments` as `rep` and as `admin` | All six refused with `42501` |
| 2.6 | `apply_inventory_sync` as admin with a non-empty `matches` array | Refused with **`KY016`** — a stale caller fails loudly |
| 2.7 | `apply_inventory_sync` as `rep` | Refused with **`KY003`**; the row is unchanged |
| 2.8 | Admin A corrects `SEA-9005` on hand to 50 as a manual override; admin B runs a sync reporting on hand 70, committed 30 | Row stays `manual_override` with on hand **50**; committed becomes **30**; `override_by` and `override_at` are still admin A's |
| 2.8b | Admin B then issues an attribution-only `UPDATE … SET override_by = <B>` | Accepted, but `override_by` and `override_at` are unchanged — attribution cannot be rewritten |
| 2.9 | Admin `INSERT INTO inventory` naming `qty_committed`, then the same insert without it | First refused with `42501` (column-scoped grant); second succeeds with committed **0** |

`2.8` and `2.8b` together are the regression test for the `0025` change to
`pin_override_attribution()`: before it, any update of an override row by a signed-in user —
including the sync now refreshing `qty_committed` — re-stamped the attribution to that user.

---

## 5. Attack 3 — retired

**Attack 3, "delta survives a stale baseline", is retired with migration `0025`.** It proved that
a pending portal commitment kept reducing availability across any number of syncs that did not
mention it, and that it was retired only by an explicit match, never by elapsed time. Since `0025`
the portal records no commitments, `apply_inventory_sync` no longer processes matches, and no
pending row affects any figure, so the property it protected no longer exists. The files
(`verify/03-stale-baseline.mjs`, `verify/hosted/03-stale-baseline.mjs`) are deleted and its ids
are gone from `verify/lib/manifest.mjs`. The number is not reused: attack 4 and suite 5 keep
theirs, so existing references stay valid. The lifecycle trigger on `commitments` it also
exercised is still installed; with client writes revoked it guards history only.

---

## 6. Attack 4 — role enforcement is server-side

`verify/hosted/04-role-enforcement.mjs` (hosted) and `verify/04-role-enforcement.mjs` (local).

> **Hosted:** the assertions run live over PostgREST against real GoTrue sessions. The
> **conditional** ones are `4.9` and `4.10`, on `PORTAL_BASE_URL` being set and on the app
> accepting the harness-minted session, and `4.12b`, on the current `inventory_authority` being
> readable
> (`04-role-enforcement.mjs`). A conditional whose precondition does not hold is reported
> NOT EXECUTED with its reason and is never counted as a pass. The counts are in the
> disposition block in §8. Writes target `KYV-0001` and `KYV-0002`, never `SEA-9007`.
>
> **4.12b** reads `inventory_authority` and writes **that same value** back, asserting 1 row
> affected. (Since `0025` the app no longer reads this column, but it remains a column of
> `app_settings` and an equally good target for the update policy.) `app_settings` is a singleton with no disposable copy, and over PostgREST the
> original `SET inventory_authority = 'portal'` would commit and flip the live portal's
> authority mode. The affected-row count is 1 either way, so the policy is proven exactly as
> strongly; the `WHERE` clause stays identical to 4.4's, which is the evidential point.
>
> **4.10 asserts the 307, specifically.** `middleware.ts` matches `/api/*` and redirects an
> unauthenticated request to `/login` **before** the route handler runs, so the route's own 401
> is never reached. That redirect is the refusal, and it is what the assertion asserts:
> `NextResponse.redirect(url)` with no init defaults to **307** and
> `lib/supabase/middleware.ts:58` uses exactly that form, so the assertion requires HTTP 307
> **and** a `Location` resolving to path `/login` **and** no new `inventory_sync_runs` row.
>
> It used to accept `401 || a redirect`, and that was a defect in the assertion. A disjunction
> over two different mechanisms cannot fail on the wrong mechanism — it proved only that the
> request did not succeed while wearing a much stronger label. The disjunction is gone.
>
> The route handler's own 401 is recorded as **`4.10b`, NOT EXECUTED**, on every run: it is
> unreachable, because middleware refuses first. Middleware refusing first is a **stronger**
> refusal, not a weaker one, so `middleware.ts` is deliberately **not** changed to make
> `4.10b` reachable.

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
| 4.10 | `POST /api/sync` with **no** session | `middleware.ts`, before the route handler | **307** redirect to `/login` (middleware refusal), and no new `inventory_sync_runs` row |
| 4.10b | `POST /api/sync` with **no** session, reaching the route handler's own 401 | Route handler guard (`app/api/sync/route.ts`) | **NOT EXECUTED — unreachable: middleware refuses first** |
| 4.11 | Same as 4.6 but as `anon` | `EXECUTE` revoked from `anon` (`0012`) | `42501` — the grant refuses before the function is entered |
| 4.12 | Control: 4.1, 4.4 and 4.6 as `admin` | — | All **succeed**. Proves the tests are testing the role and not a blanket denial. |
| 4.13 | Same as 4.11, but with `EXECUTE` **deliberately granted** to `anon` first | The role guard **inside** the effective `apply_inventory_sync` (`0025`), on its own | **`KY003`**. Local only (`live`); `STATIC` source check on the hosted path |

4.12 is not optional. Without it, a build that refuses everything for everyone would pass 4.1
through 4.11 and be reported as secure.

**4.13 exists because 4.11 proves the wrong half.** 4.11 proves the `EXECUTE` revoke in `0012`
refuses `anon` — it never reaches the function, so it says nothing about the guard inside it. The
guard used to be `IF auth.uid() IS NOT NULL AND NOT public.is_admin()`, which permitted every
NULL-uid caller and was safe *only* because of that revoke: a **two-file** property, with a real
window during hand-paced manual migration application between pasting `0010` and pasting `0012`
in which the database sits fail-open. The guard is now deny-by-default within `0010` itself, and
4.13 proves it by granting `anon` `EXECUTE` on purpose and requiring `KY003` anyway. The `REVOKE`
runs in a `finally`, and the target is an ephemeral database that `bootstrap()` drops and
recreates on every run — `bootstrap()` refuses any host that is not loopback.

On the hosted path 4.13 is `STATIC`: it resolves the **effective** `apply_inventory_sync`
definition — the last one applied in migration order (0010, replaced by 0013, replaced by 0025),
with line comments stripped (`verify/hosted/lib/migration-source.mjs`) — and checks it for both
`COALESCE` terms and for the absence of the old fail-open form. Hosted 1.12 resolves the
effective `v_inventory` definition the same way, so neither can pass against a superseded file. Granting `anon` `EXECUTE`
on a live project to prove a guard is a real privilege change and is refused. That is a limit of
the hosted path, printed as one, and never counted as a live pass.

**Where the check lives, per admin-only action** — this is the answer to D7 #4:

| Admin-only action | Enforcing layer |
|---|---|
| Edit inventory quantities | RLS `inventory_update_admin` (database) |
| Create/edit/delete products | RLS `products_*_admin` (database) |
| Change `inventory_authority` or thresholds | RLS `app_settings_update_admin` (database) |
| Read sync history | RLS `sync_runs_select_admin` (database) |
| Run an inventory sync | `is_admin()` guard inside `apply_inventory_sync` (`SECURITY DEFINER` function) **and** a `requireAdmin()` guard in `app/api/sync/route.ts`. Two layers; the database one is authoritative. |
| Change a user's role | RLS `profiles_update_admin` (database) |
| Write a commitment row directly | No policy exists for anyone, and since `0025` no privilege for `anon` or `authenticated` (database) |
| Enter a committed figure | Not writable by any client: `qty_committed` is outside the column-scoped `INSERT` and `UPDATE` grants; only `apply_inventory_sync` sets it (database) |

The route-handler guards exist to return a clean 403 instead of a 500. They are **not** the
access control. Every one of them has a database-level refusal underneath it, and attacks 4.1
through 4.8 bypass the route handlers entirely to prove it.

---

## 7. Suite 5 — magic-link request failure modes (a regression suite, NOT a fifth attack)

`verify/hosted/05-login-failure-modes.mjs`, plus `verify/login-predicate.mjs` and
`verify/login-failure.mjs` as smaller entry points. The brief requires four attacks and §3–§6
cover them (attack 3 retired since `0025`, §5); this suite is printed after them, counted
separately in the disposition block below, and is never called an attack — the same way
`check:secrets` is explicitly not one of the attacks.

**The defect it exists to catch.** `requestMagicLink()` logged every error class and then
redirected to `/login/check-email` regardless. With a wrong or rotated anon key, or during a
Supabase incident, every rep saw "check your email", no email arrived and the portal looked
healthy. The anti-enumeration intent behind that code is real and survives intact, but it only
ever applied to *address-specific* conditions; "our auth provider is down" is not about the
address, and hiding it protects nobody.

`app/login/auth-error.ts` classifies the error into `SUPPRESSED` (address-specific: the same
success page as before, server-side log only), `RATE_LIMITED`, or `UNAVAILABLE`. It branches on
`status` and `code` and **never on message text**, the same house rule as `lib/errors.ts`. The
default is `UNAVAILABLE`: anything unrecognised fails honestly rather than being reported as a
sent email.

### The unclassified-error default, and what it costs

Two directions were safe here, and they point opposite ways.

- **A — chosen.** An auth error matching no known `status`/`code` branch classifies
  **UNAVAILABLE**. The caller is told the portal cannot send, and the address is never mentioned.
- **B — rejected.** Default to **SUPPRESSED**, so an unseen code can never leak whether an
  address is registered.

**Why A.** The failure B prevents is *total*. A wrong or rotated anon key makes the portal look
healthy while none of the ~120 reps can sign in, evidenced only by a log nobody is watching. The
failure A risks is *narrow and conjunctive*: it needs a dependency bump that renames an
address-specific code out of `SUPPRESSED_CODES` **and** an attacker probing addresses, and what
it yields is only whether one address is registered.

**What A costs, stated plainly.** The anti-enumeration property is no longer guaranteed by the
classifier alone. It is guaranteed by the classifier **plus assertion 5.4**. If such a rename
happens, the unregistered address is answered `/login?error=unavailable` while the registered one
is answered `/login/check-email`, the two responses stop being indistinguishable, and 5.4 fails.

**That is why 5.4 is blocking, and the chain is not a matter of anyone's care.** Each `5.4`
comparison is a `report.check`; a `check` whose condition does not hold calls `fail()`, which
records `STATUS.FAIL`; any `FAIL` makes that report's `ok` false; `run-all.mjs` folds the
regression suite into `anyFailed` alongside the attacks and exits non-zero on it. There is
no warning tier for 5.4 to land in. It is also why the comparison is now structurally unable to
report `NOT EXECUTED` once both responses are in hand: `resolveEquivalenceInputs` owns every
precondition and never sees the report, and `assertEquivalence` is handed a verdict-only view
whose `notExecuted` throws. `NOT EXECUTED` and `FAIL` mean opposite things — "we have no
evidence" against "we have evidence and it differed" — and the ruling above rests on 5.4 being
able to say the second one.

**Where the mitigation is not in force.** 5.4 is conditional on `PORTAL_BASE_URL`. When it
degrades to `NOT EXECUTED` for a genuine precondition — no base URL, the app unreachable, the
no-JS Server Action encoding not locatable — the mitigation did not run for that run, and the
run says so on every affected assertion line and again in the summary. Absence of evidence,
printed as absence of evidence, never quietly as a pass.

**The rate-limit asymmetry — CLOSED on 2026-08-19.** This paragraph used to describe an open
enumeration oracle. It no longer does, and the correction matters more than the history.

With `shouldCreateUser: false` the email-send path is reached only for registered addresses, so
`over_email_send_rate_limit` fires only for a registered address. While that code classified
`RATE_LIMITED`, an attacker who submitted the same address twice inside the per-address throttle
window got `/login?error=rate_limited` for a registered address and `/login/check-email` for an
unregistered one — a reliable oracle against the same ~120 named reps the anti-enumeration
defence exists to protect. A run in which **only the registered address** was throttled was
itself an instance of that signal.

Under the 2026-08-19 ruling — *a security predicate that branches on unmeasured vendor behaviour
must fail toward the safe classification until it is measured* — `over_email_send_rate_limit` was
moved into `SUPPRESSED_CODES` in `app/login/auth-error.ts`. The registered and unregistered
responses are now identical **inside** the throttle window as well as outside it, so:

- the oracle is closed at the predicate, not merely undisclosed by the harness;
- **5.4 no longer degrades to `NOT EXECUTED` on a one-sided throttle for that code.** A
  throttled registered address now redirects to `/login/check-email`, byte-identical to the
  unregistered one, which is the comparison 5.4c makes. `isRateLimitRedirect` still exists and
  still guards `over_request_rate_limit` and a bare `429`, both of which are IP/route-level and
  address-independent — those remain legitimate re-run conditions.

The Human's sanction of "throttle fired → `NOT EXECUTED`" stands for the codes that still reach
`RATE_LIMITED`; it is simply no longer reachable via the per-address code. `RATE_LIMIT_CODES`
correctly retains exactly one member, `over_request_rate_limit`.

The cost of the move — suppressing a throttle re-hides a project-wide failure mode — is paid by
`GET /api/health/auth` (see "The configuration health signal" later in this section), not
absorbed.

**A concrete case the default catches.** `@supabase/auth-js` throws `AuthUnknownError` when the
response body will not parse as JSON and the status is not in its network-error list
(`lib/fetch.js:49`), and `AuthUnknownError` carries neither `status` nor `code`
(`lib/errors.js:79-85`). So a gateway 401 delivered as an HTML edge error page — precisely the
invalid-anon-key shape the inference note in `app/login/auth-error.ts` describes — does **not**
reach the 401 branch. It falls through to the default and lands `unavailable:unclassified`, and
the portal still fails honestly. That branch is the one `UNCLASSIFIED_AUTH_ERROR` exists to make
findable: `app/login/actions.ts` logs that marker, on that reason only, carrying `status`, `code`
and `name` and never the address, so the case can be grepped out of a production log instead of
inferred from a redirect.

| Group | What it asserts | When it runs |
|---|---|---|
| `5.1.x` | every branch of the classification predicate, executing the application's real `classifyAuthError` | always — no network, no credentials, no database. Also runs alone as `npm run verify:login-predicate` |
| `5.2a–c` | the **real** hosted gateway's error shape for a deliberately invalid apikey, and that it classifies `UNAVAILABLE`. The observed `status` and `code` are recorded verbatim in the run notes | every hosted run |
| `5.3a–d` | `/login?error=unavailable` and `?error=rate_limited` render their notices; `?invalid=1` still renders its pre-existing one; bare `/login` renders neither | when `PORTAL_BASE_URL` is set |
| `5.4a–d` | **anti-enumeration:** a registered and an unregistered address get responses that are *indistinguishable* — same `Location`, byte for byte, no query string, same status code | when `PORTAL_BASE_URL` is set |
| `5.5a–b` | **the defect itself:** an invalid anon key redirects to `/login?error=unavailable` and specifically **not** to `/login/check-email`, and the server-side log line survives | opt-in: `npm run verify:login-failure` |

**5.1 executes the product's code, it does not mirror it.** `app/login/auth-error.ts` imports
nothing — no package, no `@/` alias — so `tsc` compiles it standalone into `verify/.out` with
CLI flags (`tsconfig.json` is neither touched nor used) and the harness imports the compiled
artefact. A mirrored predicate would pass its own tests forever while the application diverged
from it. If the compile fails, every 5.1 and 5.2 assertion is `NOT EXECUTED` with the compiler
output as the reason: never PASS, never FAIL.

**The 401 inference, and how 5.2 converts it into a measurement.** "HTTP 401 on `signInWithOtp`
means the anon key is bad" is an inference from endpoint semantics — an unauthenticated
endpoint has no legitimate reason to answer 401 — not a measured fact, and the invalid-key case
is precisely the one that can arrive with `code` undefined, because it is rejected at the
edge before GoTrue sees it. `5.2` calls the real gateway with a deliberately invalid apikey on
every hosted run and records what actually came back. If Supabase ever answers something else,
`5.2b` fails loudly instead of the portal failing silently.

### How 5.5 is made reachable — the deliberately invalid key

This is the branch that never fires by accident, because everyone runs with a valid key. So it
is made to fire on purpose:

```bash
npm run verify:login-failure
```

`verify/login-failure.mjs` boots a **second** copy of the application as a child process on an
ephemeral loopback port, with `NEXT_PUBLIC_SUPABASE_ANON_KEY` replaced by a deliberately
invalid, non-key-shaped literal and `SUPABASE_SERVICE_ROLE_KEY` **deleted** from the child's
environment. `NEXT_PUBLIC_SUPABASE_URL` is passed through unchanged, so the request reaches the
configured gateway and gets its real answer; pointing it at a non-routable host exercises the
same `UNAVAILABLE` branch without contacting the hosted project:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://offline.example.invalid npm run verify:login-failure
```

`next dev` is used rather than `next start`, so `NEXT_PUBLIC_*` is read at runtime on the server
and no rebuild is needed. The child is killed in a `finally` block and again on `SIGINT`. **The
default `npm run verify` never boots it** — there, `5.5a` and `5.5b` are `NOT EXECUTED` with the
reason and this command named as the way to run them.

Why `/login` still renders under an invalid key, which is what makes the mechanism work at all:
`lib/supabase/middleware.ts` destructures only `data.user` and ignores the error, so an invalid
key yields `user = null`; `/login` is in `PUBLIC_PATHS`, so the request passes through, and the
login page itself calls no Supabase API. Only the Server Action does.

**5.4 and 5.5 drive the form through the no-JS Server Action encoding** — the hidden
`$ACTION_ID_*` field Next renders for clients without JavaScript — which is a **framework
internal, pinned to next 15.5.23**. It is isolated to one helper function. If the field cannot
be located, every assertion that depends on it is `NOT EXECUTED` with that reason; a framework
rename is not a defect in this application and must never be reported as one. Likewise, if the
per-address email throttle fires (5.4b sends a real magic link to a non-routable address and
consumes that address's throttle), 5.4 reports `NOT EXECUTED — re-run after the throttle
window` rather than failing.

### The configuration health signal — `5.6a`–`5.6h`

`GET /api/health/auth` (`app/api/health/auth/route.ts`) is **the cost of the 2026-08-19 ruling,
paid rather than absorbed.** With `otp_disabled` and `over_email_send_rate_limit` classified
`SUPPRESSED`, a project in which nobody can sign in answers every rep with the same
"check your email" page a healthy project answers. That is the right user-facing behaviour and it
re-hides a real outage. This endpoint reports the same conditions from the server side, with no
address, no session and no user input.

**It can prove "OTP is disabled" and can never prove "OTP is enabled."** A constant address in
the reserved `.invalid` TLD is submitted with `shouldCreateUser: false`. If GoTrue answers
`otp_disabled` for an address that can never be registered, OTP is off project-wide and that is
conclusive and address-independent. Any other answer is inconclusive. So `otpEnabled` has exactly
two values in its type — `"no"` and `"unknown"` — and `"yes"` is deliberately absent from the
union. `5.6d` asserts that absence rather than trusting a comment to preserve it.

**It is unauthenticated, deliberately**, because the failure it detects is exactly the failure in
which nobody can obtain a session. Safety is structural instead: no input of any kind, a
module-constant probe address, a closed value vocabulary, no free-text field on the 200 response,
and a rate limiter that runs before the vendor is touched. It does **not** call
`classifyAuthError` — that predicate answers "what may the user be told", and since the ruling it
classifies a disabled project as `SUPPRESSED`, so reading it here would report an outage as
healthy. Different question, different mapping, branching on `status` and `code` only.

| id | Asserts |
|---|---|
| `5.6a` | 200 with a JSON content-type |
| `5.6b` | **exactly** the five declared keys — `checkedAt`, `authEndpointReachable`, `anonKeyAccepted`, `otpEnabled`, `verdict`. **Any extra key FAILS.** This is the anti-leak assertion: a health endpoint grows a `detail` field the moment someone is debugging, and free text is how a key or an address gets out of one |
| `5.6c` | every value is inside its declared closed set, and `checkedAt` parses as a date |
| `5.6d` | `otpEnabled` is never `"yes"` |
| `5.6e` | the **raw response text** contains no `@` and nothing JWT-shaped |
| `5.6f` | `POST` is refused with `405` and `Allow: GET` |
| `5.6g` | **the measurement.** Records the observed `otpEnabled` and `verdict` verbatim in the run notes. This is the evidence that settles the `otp_disabled` classification in `app/login/auth-error.ts` — read it before revisiting that row |
| `5.6h` | the rate limiter fires within 10 sequential GETs and carries `Retry-After`. **Evidences in-process behaviour on a single instance only** — the limiter is a module-level `Map`, so on a multi-instance deployment the effective global limit is (instances × limit) and a cold start resets it. Runs last, because it deliberately exhausts the window |

All eight are `hosted: conditional` on `PORTAL_BASE_URL` and `local: absent`.

### `5.7a` / `5.7b` — the httpOnly measurement that is owed

`lib/supabase/server.ts` and `lib/supabase/middleware.ts` set `httpOnly: true` on the Supabase
auth cookie, overriding `@supabase/ssr`'s documented default of `false`. The finding that asked
for it also asked that it be verified **by exercising sign-in through the SSR flow**, not by
reasoning about it.

**That exercise was not executable at build stage** — local verification runs against bare
Postgres with a SQL shim, there is no local GoTrue and no auth server of any kind, and the hosted
project was off limits to every stage before this one. So the measurement was **scheduled here
rather than claimed**. `5.7a` asserts the SSR session round-trip still works with `httpOnly`
cookies (a `GET /` with the minted rep session must not be answered with a `/login` redirect);
`5.7b` asserts every `sb-*` `Set-Cookie` carries `HttpOnly`. Cookie **values are never printed**,
only the attribute list.

**A `NOT EXECUTED` on 5.7 means the measurement still has not been taken**, and must not be
written up as though it had. `5.7b` reports `NOT EXECUTED` rather than passing when the response
carries no `sb-*` `Set-Cookie` at all — `@supabase/ssr` only writes on a token refresh, so a
freshly minted session usually produces none, and asserting over an empty list would pass
vacuously.

---

## 8. Output contract

`npm run verify` prints, in order: a banner naming the channel; a **booleans-only**
configuration block; a read-only preflight; attacks 1, 2 and 4; suite 5, labelled
`SUITE` and not `ATTACK`; a summary; the manifest-drift result; and the disposition block.

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
ATTACK 2 — QuickBooks is the only source of committed
  Target:  hosted Supabase project rakslwwxduovcqnuercz (PostgREST + GoTrue over HTTPS)
  Method: figures are read through v_inventory with the rep session …
  2.1  rep v_inventory.qty_committed equals inventory.qty_committed … PASS
  2.4  record_commitment does not exist for rep or admin … PASS
  2.6  apply_inventory_sync with a non-empty matches array is refused (KY016) … PASS
  RESULT: PASS (…counts…)
```

The `RESULT:` line above is an **illustration of the shape, not of any run**. The real figures
come from the run. This document contains no example of one, deliberately: the previous version
of this block printed a split no run could produce and listed an attack 1 assertion under attack
2, and it was believed for a full loop because it looked like output.

The summary then lists **every** `NOT EXECUTED` assertion with its reason and **every**
`STATIC` assertion with the note that it asserts migration source rather than deployed state.

**No hand-written count of anything the code can count appears in this document.** The single,
labelled exception is the generated region below, which `npm run verify:disposition` produces
from `verify/lib/manifest.mjs` and `npm run check:disposition` verifies has not drifted. Totals
in a run are computed from what actually ran. A figure from a previous run against a different
target is not a result.

### The assertion disposition

Three artefacts locked to each other in both directions:

- **`verify/lib/manifest.mjs`** declares one entry per assertion id, with its state on each path
  (`live`, `conditional`, `static`, `not-executed`, `absent`).
- **`checkDrift()`** runs at the end of *both* runners and compares the declaration against the
  ids the run actually emitted, **in both directions** — emitted-but-not-declared and
  declared-but-not-emitted. Any drift prints a `MANIFEST DRIFT` block and forces a non-zero
  exit. That is what stops the manifest becoming a second stale document.
- **`npm run check:disposition`** regenerates the block below in memory and exits non-zero if
  the committed copy differs. `npm run verify:disposition -- --write` rewrites it.

Why it is computed rather than counted: not every id appears in this document in countable
form — the single `4.12` row in §6 is several assertions in the code, and suite 5's `5.1.x`
family is generated from a table — and the inventory changes when suites do, as it did when
`0025` replaced attack 2 and retired attack 3. A number describing generated output has to be
generated.

<!-- DISPOSITION:BEGIN — generated by `npm run verify:disposition`. Do not edit by hand. -->

```
ASSERTION DISPOSITION — computed from verify/lib/manifest.mjs by
verify/lib/disposition.mjs. Nothing here is hand-counted, and no count of anything
the code can count appears in the prose of docs/VERIFICATION.md.

  THE REQUIRED ATTACKS (suites 1, 2, 4)

    Total distinct assertion ids .................................. 46
    Executable remotely  (npm run verify) ......................... 43
      of which conditional on a precondition ...................... 3
    STATIC — asserts the migration source, not deployed ........... 2
    NOT EXECUTED on the hosted path ............................... 1

    Executes live ONLY under npm run verify:local ................. 2
    Executes live ONLY under npm run verify ....................... 2
    Executes live on BOTH paths ................................... 41
    Executes live on NEITHER path ................................. 1

    41 + 2 + 2 + 1 = 46 (declared total 46)

    Remote-only :
      4.9, 4.10
    Neither     :
      4.10b

    Per suite (hosted / local, executable live or conditional):
      suite 1: 17 ids — hosted 16 executable, 1 STATIC, 0 NOT EXECUTED | local 17 executable
      suite 2: 10 ids — hosted 10 executable, 0 STATIC, 0 NOT EXECUTED | local 10 executable
      suite 4: 19 ids — hosted 17 executable, 1 STATIC, 1 NOT EXECUTED | local 16 executable, 1 absent

  REGRESSION SUITE 5 — magic-link request failure modes

    Total distinct assertion ids .................................. 45
    Executable remotely  (npm run verify) ......................... 38
      of which conditional on a precondition ...................... 21
    STATIC — asserts the migration source, not deployed ........... 5
    NOT EXECUTED on the hosted path ............................... 2

    Executes live ONLY under npm run verify:local ................. 0
    Executes live ONLY under npm run verify ....................... 38
    Executes live on BOTH paths ................................... 0
    Executes live on NEITHER path ................................. 7

    0 + 0 + 38 + 7 = 45 (declared total 45)

    Remote-only :
      5.1.1, 5.1.2, 5.1.3, 5.1.4, 5.1.5, 5.1.6, 5.1.7, 5.1.8, 5.1.9, 5.1.10, 5.1.11, 5.1.12,
      5.1.13, 5.1.14, 5.1.15, 5.1.16, 5.1.17, 5.2a, 5.2b, 5.2c, 5.3a, 5.3b, 5.3c, 5.3d, 5.4a,
      5.4b, 5.4c, 5.4d, 5.6a, 5.6b, 5.6c, 5.6d, 5.6e, 5.6f, 5.6g, 5.6h, 5.7a, 5.7b
    Neither     :
      5.C1, 5.C2, 5.C3, 5.C4, 5.C5, 5.5a, 5.5b
    Also run by `npm run verify:login-predicate` (22 ids):
      5.1.1, 5.1.2, 5.1.3, 5.1.4, 5.1.5, 5.1.6, 5.1.7, 5.1.8, 5.1.9, 5.1.10, 5.1.11, 5.1.12,
      5.1.13, 5.1.14, 5.1.15, 5.1.16, 5.1.17, 5.C1, 5.C2, 5.C3, 5.C4, 5.C5
    Opt-in      : 5.5a executes under `npm run verify:login-failure`
    Opt-in      : 5.5b executes under `npm run verify:login-failure`

    Per suite (hosted / local, executable live or conditional):
      suite 5: 45 ids — hosted 38 executable, 5 STATIC, 2 NOT EXECUTED | local 0 executable, 45 absent

  READ "executable remotely" AS A MAXIMUM, NOT A PROMISE. It counts the conditional
  assertions as executable, and each of those has a precondition that can fail to hold:
  PORTAL_BASE_URL set, the running app accepting the harness-minted session, app_settings
  readable, service_role holding the UPDATE grant it needs. When a precondition does not
  hold the assertion is reported NOT EXECUTED with its reason and is never counted as a
  pass. The per-run figures the runner prints below its attacks are the actual result;
  this block is the inventory those results are drawn from.

  A STATIC assertion appears under "Executes live on NEITHER path" because it asserts
  SOURCE — the committed migration text, or the shape of a declared table — and source is
  not a live execution against any target. It is there because that is what it is, not
  because it was skipped, and it really did run. Do not read that bucket as a count of
  assertions nothing exercises.
```

<!-- DISPOSITION:END -->

Exit code is 0 only if nothing failed. A `NOT EXECUTED` is never counted as a pass. Missing
configuration, an unreachable endpoint, an unapplied schema, an unapplied seed, a violated run
order or absent test identities each abort the run with their own verdict string and a
non-zero exit.

`scripts/check-no-secrets.sh` runs separately and is **not** one of the attacks: it greps
the repo for key-shaped strings (`eyJ`-prefixed JWTs, `sb[a-z]*_`-prefixed keys, credential
assignments), for a service-role key exposed via a `NEXT_PUBLIC_` prefix, and for any
environment value reaching stdout. Its dotenv scan is **git-aware**: it fails on a dotenv file
that is *tracked by git* or that is present but *not gitignored*, repo-wide and at any depth. A
dotenv file that is present and correctly ignored is reported `ok` — git is the authority on
what can be committed, and a depth-limited `find` was both blind to deep files and wrong about
a normal working tree.

---

## 9. What cannot be verified in this environment

Stated plainly rather than papered over. Note that one bullet has **inverted** since the
previous revision.

- **Magic-link email delivery.** Still unverifiable, and now for a sharper reason: the harness
  bypasses email *by design* — `generateLink` plus `verifyOtp` is what makes unattended
  verification possible at all — so it proves nothing about whether a link actually reaches an
  inbox. Only a Human signing in can confirm that.
- **The magic-link REQUEST path's failure modes — NO LONGER ON THIS LIST.** Distinct from
  delivery, and now covered by suite 5 (§7): `5.1` the classification predicate, executing the
  application's real code, on every run; `5.2` the real hosted gateway's error shape for an
  invalid key, on every hosted run; `5.3` the rendered error page; `5.4` the anti-enumeration
  equivalence of the registered and unregistered responses; `5.5` the whole path end to end
  under a deliberately invalid anon key, on demand. **This does not make delivery verified. It
  is not.** What remains uncovered *in the default run* is the single-process path from a real
  invalid key to a rendered error page — `5.5` covers exactly that, on demand, via
  `npm run verify:login-failure`, and is reported `NOT EXECUTED` in every run that does not opt
  in.
- **The hosted project's actual RLS state — NO LONGER ON THIS LIST.** It was unverifiable when
  the harness could only reach a local database. It becomes verifiable the moment the Human
  applies migrations `0001`–`0025` and runs `npm run verify`, which is what this tooling now
  exists to do. Until they are applied, the preflight reports
  `NOT EXECUTED — schema not applied` rather than claiming anything.
- **Raw-SQL, open-transaction and `pg_catalog` assertions against hosted.** PostgREST gives one
  transaction per request and no catalog access. Since `0025` replaced attack 2 and retired
  attack 3, no remaining assertion needs an open transaction; the ones that needed it (the
  deterministic last-unit interleaving and the commitment-ageing steps) went with those suites.
- **Deployed function and view bodies.** `pg_get_functiondef` and `pg_class` are not exposed
  over PostgREST, so `1.12` is a `STATIC` check of the migration source (and `4.13` is `STATIC`
  on hosted for the privilege reason in §6). `verify:local` inspects a deployed object — but a
  locally deployed one.
- **Stock promised before a QuickBooks sales order exists.** Not a verification gap but a
  product limit, recorded here so it is not mistaken for one: since `0025` such stock is not
  shown as committed, by decision (`QUESTIONS-FOR-LEVON.md` item 3). No test can make the
  portal know about a sale QuickBooks has not been told about.
- **JWT signing and verification under `verify:local`.** That path sets the claims GUC
  directly. It is now covered against hosted, which is the point of this revision.
- **Netlify deployment and the public URL.** Deploy is a push, and pushing is a Human action.
- **Real Web Push.** Out of scope by the brief; nothing to verify.

---

## 10. Accepted open items — the 2026-08-19 security rework, loop 2

Recorded here so they are decisions with reasons attached, not omissions. Each was evaluated
and left open on its merits; none is "we ran out of time".

**1. CSP `script-src` is still absent.** Re-evaluated in full and recorded in
`next.config.mjs`. `'unsafe-inline'` was rejected because it permits exactly the inline
execution the directive exists to prevent — the header would look like a CSP in a scan report
and defend against nothing, which is an overclaim. Hashes were rejected because Next.js's inline
bootstrap varies by build and by route, so a static hash list breaks the app on the next build.
Nonces were rejected **for this pass, on scope**: they require per-request generation threaded
through `lib/supabase/middleware.ts` into `app/layout.tsx`, which is a functional change on a
hardening pass. **Step-2 recommendation:** `script-src 'self' 'nonce-…' 'strict-dynamic'`, with
its own scope and its own approval. The four directives that *are* present —
`frame-ancestors`, `base-uri`, `form-action`, `object-src` — are unchanged and remain
enforceable with no behavioural risk.

**2. The second, timing-based enumeration channel — DOCUMENTATION ONLY, and here is exactly
why.** The rework brief named a second enumeration channel described in an auditor write-up.
**That write-up is not in this repository and was not available at build stage.** The project
and the pipeline repo were both searched for `timing`, `side channel`, `oracle`, `latency`,
`elapsed`, `response time` and `second channel`; nothing matching exists in either.

The only second enumeration channel documented anywhere in this repo is the **throttle-window
oracle** — recorded in `app/login/auth-error.ts`, `docs/PLAN.md` and §7 above. It is
time-*dependent* (it turns on whether you are inside the per-address throttle window) and is
plausibly what was meant. **If that is the channel, it is CLOSED** by classifying
`over_email_send_rate_limit` as SUPPRESSED: the registered and unregistered responses are now
identical inside the window as well as outside it.

**If a genuinely distinct response-LATENCY channel was meant** — the registered path performs an
email send and is measurably slower than the unregistered path — **that is not closed, and no
mitigation was implemented.** Constant-time padding costs every user real latency, is unreliable
across serverless cold starts, and is a functional change. **No latency mitigation was invented
against a channel whose description could not be read.** The write-up has been requested; if it
describes a distinct channel this returns as a scoped follow-up.

**3. The two `nextUrl.clone()` same-origin redirects, left in place.**
`lib/supabase/middleware.ts` (the unauthenticated redirect to `/login` and the signed-in
redirect to `/inventory`) and `app/signout/route.ts` still build their redirect from
`request.nextUrl`, which is host-header-derived. **They are not the B3 defect and were not
changed.** These are same-origin redirects returned to the requester's own browser: a poisoned
host header there redirects *the attacker's own browser* to *the attacker's own host*. No email
is sent, no token is issued, no victim is involved. The defect that was fixed is the one where a
header steers a token into an *email addressed to someone else* — `emailRedirectTo` in
`app/login/actions.ts` and the two outbound redirects in `app/auth/callback/route.ts`, both of
which now resolve against `NEXT_PUBLIC_SITE_URL`.

**4. The rate limiter is per-instance, not global.** `lib/rate-limit.ts` is a module-level `Map`
in one process. On Netlify each serverless instance has its own and a cold start resets it, so
the effective global limit is (instances × limit). It is friction, not a guarantee, and the file
says so at the point of definition. `5.6h` evidences in-process behaviour on a single instance
only and its detail string says that too. A shared store — Redis/Upstash, or a Postgres table —
is the step-2 answer. The database remains the real gate in every case.

**5. The httpOnly behavioural measurement is owed, scheduled, and not yet taken.** See §7,
`5.7a`/`5.7b`. `httpOnly: true` is set on code evidence and a local mechanical probe; the
behavioural SSR sign-in exercise was not executable at build stage and must not be written up as
though it had been.

**6. B2 — the two hosted auth settings are a HUMAN ACTION and no code can create them.** README
step 3b, which now opens with that statement and carries two dated confirmation checkboxes.
Until a person turns project-level signup off and pins the Redirect URL allow-list, those
security properties **do not exist**, regardless of what this repository contains.
