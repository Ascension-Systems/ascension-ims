# Verification harness — the required attacks

The things in this build most likely to be confidently wrong **fail silently** — nothing in
the UI reveals them. Rendering the page is not sufficient. Each is actively attacked here, not
merely exercised.

**Since migration `0025` (3 Oct 2026) the attacks are 1, 2 and 4.** Reps no longer record
commitments in the portal; "committed" is QuickBooks' quantity on open sales orders. Attack 2
is now "QuickBooks is the only source of committed"; attack 3 ("delta survives a stale
baseline") is retired, because the ledger it protected no longer exists. Attack 4 keeps its
number. Full rationale in `docs/VERIFICATION.md` §4–§5.

**Assertions run against a real database, never against mocks.** A mocked RLS policy proves
nothing; that is the whole point of these attacks.

```
npm run verify:preflight        # read-only. Creates nothing. Tells you what is missing
npm run verify:identities       # creates the two test identities on the hosted project
npm run verify                  # attacks 1, 2, 4 and suite 5, against the hosted project
npm run verify:identities:remove  # removes every artefact the above created
```

The ordered, zero-prior-context procedure — migrations, seed, users, seed `0003` (SEA-9003
attribution), and the order they must go in — is in **`README.md`, "Running this against the hosted Supabase
project"**. It is not restated here. Read it before running anything.

---

## The one rule

**Never print PASS for anything not actually executed.** Every assertion ends in exactly one
of four states, and there is no fifth:

| Status | Means |
|---|---|
| `PASS` / `FAIL` | executed against the hosted project over HTTPS |
| `STATIC` | executed against the committed **migration source**, not deployed state. Real, labelled, and never reported as a live database result |
| `NOT EXECUTED` | did not run. The reason is printed on the assertion line and again in the run summary. **Never counted as a pass** |

Totals are computed from what actually ran. Nothing is seeded with an expected count.

---

## How it reaches the database

`npm run verify` talks to the configured hosted Supabase project over **HTTPS only**.

| Channel | Used for |
|---|---|
| PostgREST `/rest/v1/…` | table reads, filtered writes, refusal SQLSTATEs |
| PostgREST `/rest/v1/rpc/…` | `apply_inventory_sync`; `record_commitment` only to assert it no longer exists (`2.4`) |
| GoTrue `/auth/v1/…` | admin user creation, magic-link generation, OTP exchange, real signed JWTs |
| the running app over HTTP | `POST /api/documents` (session probe), `POST /api/sync` — only when `PORTAL_BASE_URL` is set |

**There is no `SUPABASE_DB_URL` and no `DATABASE_URL`, deliberately.** A Supabase direct or
pooler connection string embeds the database password, and the credential rule forbids
accepting a password. No `pg` client exists anywhere on the hosted path — the module graph of
`verify/run-all.mjs` contains neither `pg` nor `embedded-postgres`.

Three consequences drive the whole classification below:

1. **Each request is its own transaction.** No `BEGIN`, no lock held across statements, no
   `SET LOCAL ROLE`. Any assertion that depends on a transaction staying open is unreachable.
2. **`pg_catalog` is not exposed.** `pg_class`, `pg_locks`, `pg_stat_activity`,
   `pg_get_functiondef`, `pg_blocking_pids` are all unreachable.
3. **There is no rollback. Every request commits.** See "What this writes", below.

### Configuration, and the absence of a fallback

The three variables the application reads are the three the harness needs:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
They are read from the environment, or from `.env.local` if present — and a value already in
the environment always wins, so a command-line override is never silently discarded.

`PORTAL_BASE_URL` is a **harness-only** input. It is deliberately absent from `.env.example`,
because that file is copied to `.env.local` and consumed by Next.js, and the application never
reads this name. Pass it on the command line:

```
PORTAL_BASE_URL=http://127.0.0.1:3000 npm run verify
```

**The configuration proof prints booleans and nothing else** — `set` / `unset`, plus the
project ref (which is in the URL and is not a credential). Never a fragment, prefix, suffix,
length, character count, hash, checksum or masked form of any value: a length is a fingerprint
and so is a hash. `scripts/check-no-secrets.sh` enforces this mechanically with a scan that
fails on any line in `verify/` or `scripts/` that both writes to stdout and reads
`process.env`.

**If configuration is missing or the endpoint is unreachable, every affected attack prints
`NOT EXECUTED — no Supabase configuration` and the command exits non-zero.** It does not fall
back to a local database. There is no code path from `npm run verify` to the embedded-Postgres
harness.

### Preflight — "schema not applied" is its own answer

Migrations `0001`–`0025` are applied by hand. A first hosted run finds no tables at all, and
conflating that with a missing environment variable sends the reader to the wrong dashboard
page. The verdicts are distinct strings and are never substituted for one another:

```
NOT EXECUTED — no Supabase configuration
NOT EXECUTED — schema not applied
NOT EXECUTED — seed not applied
NOT EXECUTED — SEA-9003 not attributed (seed 0003), run order violated
NOT EXECUTED — test identities not provisioned (run npm run verify:identities)
```

A missing table surfaces from PostgREST as HTTP 404 with `code: 'PGRST205'`; the preflight
branches on that code, never on message text. It is read-only, creates nothing, and is also
available on its own as `npm run verify:preflight`.

**The attribution interlock.** `supabase/seed/0003_seed_demo_delta.sql` (filename historical)
credits `SEA-9003`'s seeded override to the **earliest** admin profile. If the verification
admin existed first it would take that credit, and `SEA-9003` would lose its attribution when
the test identities are removed. So the preflight and `npm run verify:identities` both refuse
unless `SEA-9003.override_by` names a real, non-test admin (`attributionVerdict` in
`verify/hosted/lib/identity.mjs`). Order: provision and sign in the real admin → paste seed
`0003` → then `npm run verify:identities`. Before `0025` this interlock probed for a demo rep
commitment that `0003` created; it no longer creates one.

### Identities — real sessions, no email, no password

This is the thing embedded Postgres cannot supply and the entire point of the hosted path.
Per identity, all server-side:

1. `admin.createUser({ email, email_confirm: true })` — sends no email.
2. **Upsert the `public.profiles` row via service-role.** Not optional: `README.md` documents
   that the trigger on `auth.users` may be refused on a hosted project, in which case
   `createUser` creates no profile and every rep/admin assertion fails with a confusing
   foreign-key error instead of a policy result.
3. `admin.generateLink({ type: 'magiclink', email })` → `data.properties.hashed_token`.
4. On a **separate anon client**: `verifyOtp({ token_hash: …, type: 'magiclink' })` → a session
   carrying a real GoTrue-issued, real-signed JWT.

**No password is ever set.** `createUser` is called without a password attribute and
`generateLink` type `'signup'` is not used. Sessions are held in memory for the run and are
never written to disk. One client per identity, so a misattributed request is structurally
impossible rather than merely avoided.

There is no `PORTAL_REP_COOKIE` and there never will be: an operator-supplied cookie is a
credential in a shell history. The harness builds the `@supabase/ssr` cookie itself, using
that package's own `createChunks`, so the chunking is byte-identical to what the app's reader
expects. A Supabase session JSON routinely exceeds the 3180-byte chunk threshold; assuming a
single cookie produces a 401 where a 403 was expected, which reads as a failed assertion
rather than as a broken harness.

Before any HTTP assertion runs, a **precondition probe** confirms the app accepts the minted
session: `POST /api/documents` with the rep's cookie and no body → **403** from
`requireAdmin()`, the first statement of the handler, so it writes nothing. (It deliberately
does not use `/api/sync`, which is `4.9`'s own subject.) If the session is not accepted, the HTTP assertions report `NOT EXECUTED — rep session cookie not accepted by the
app` rather than FAIL.

---

## What this writes to the live project, and how it is bounded

**This is a deliberate departure from "the harness resets `SEA-9006` qty", and it is the safer
direction.** Against embedded Postgres every destructive statement ran inside a transaction
that rolled back. Over PostgREST there is no rollback: every request commits. Ported
literally, the admin-control assertions would permanently set `SEA-9006.qty_on_hand` to 9999,
permanently **delete** the `SEA-9006` inventory row, set `SEA-9007.qty_on_hand` to 4000, and
flip `app_settings.inventory_authority` to `portal` (a column the app no longer reads since
`0025`, but still live data).

**The rule instead:** every hosted statement that writes targets either (a) a harness-owned
disposable row in the KYV namespace, or (b) `app_settings`, written back to its own current
value. **No `SEA-*` row is mutated.**

This weakens nothing. RLS policies are table-scoped, not SKU-scoped: proving
`inventory_update_admin` on `KYV-0001` is exactly as strong as proving it on `SEA-9007`, and
more deterministic, because it does not depend on the project's current state.

### The fixtures

`products.sku` is constrained to `^[A-Z]{3}-[0-9]{4}$` (`0003_products.sql:11`), so the SKUs
are `KYV-000n` — the `KYV-` prefix survives, which is what matters, since `sku LIKE 'KYV-%'`
is the single teardown predicate. All live at `location = 'kyv-verify'`.

| SKU | Shape | Used by |
|---|---|---|
| `KYV-0001` | 100 on hand, 0 committed | 1.5, 1.5b, 1.6, 4.1, 4.12a |
| `KYV-0002` | 5 on hand — created to be destroyed | 1.7, 1.7b, 4.3 |
| `KYV-0003` | 200 / 186 → available 14 | attack 1 historical commitment rows |
| `KYV-0004` | 1 on hand; committed set to 3 → **available −2** | 2.2 (committed above on hand) |
| `KYV-0005` | 3 on hand → available 3 | 2.1 |
| `KYV-0006` | 40 / 10 → available 30 | 2.3, 2.7 |
| `KYV-0007` | `manual_override` contradicting the source | 2.8, 2.8b |
| `KYV-0008` | created by 2.9 as the admin-`INSERT` target | 2.9 |

**Per full run** it creates and deletes roughly 8 products, 8 inventory rows, two historical
commitment rows (seeded by `service_role` for attack 1 — no client can write `commitments`
since `0025`) and a handful of `inventory_sync_runs` rows. **While they exist they are
visible in the application's inventory list**, under the category "KYV verification artefact".
`npm run verify` tears the fixtures down at the end; the test identities and the sync-run rows
survive deliberately, so a re-run does not have to re-mint sessions.
`npm run verify:identities:remove` removes everything.

`README.md` step 11 carries the manual equivalent, in the order the foreign keys require.
`commitments.rep_id` and `commitments (sku, location)` are both `ON DELETE RESTRICT`, and
`inventory_sync_runs.run_by` is `ON DELETE SET NULL` — so deleting the users first would NULL
`run_by` and make those rows unidentifiable. The order is not cosmetic.

---

## How a refusal is asserted

This matters, because the obvious assertion is wrong.

Postgres raises `42501` for an INSERT that violates a `WITH CHECK` policy, and for any command
whose table GRANT the role lacks — which is why every client write to `commitments` raises
(since `0025` the privileges are revoked outright), and why an `INSERT` naming
`inventory.qty_committed` raises (column-scoped grant). It does
**not** raise for an UPDATE or DELETE that an RLS `USING` clause filters out: those rows are
simply invisible to the statement, which reports 0 rows and no error.

**"No error and 0 rows" is not accepted here on its own.** For every filtered write the
harness asserts three things together:

1. the statement affected 0 rows,
2. the target row is unchanged on an independent **service-role** re-read, and
3. the **identical** request, run as `admin`, affects ≥ 1 row.

(3) is what makes it a demonstration of the policy rather than of a broken statement — and it
is what stops a build that refuses everything for everyone from being reported as secure.

---

## The attacks, and what runs where

### `verify/hosted/01-rls-bypass.mjs` — attack 1

A real GoTrue-signed rep session issues every read and write directly at PostgREST. An
admin-session control run confirms the forbidden rows exist.

| # | Attempt as `rep` | Expected | Bucket |
|---|---|---|---|
| 1.1 / 1.1b | read every commitment | only own rows; admin control sees both | live |
| 1.2 | name the admin's commitment **by id** | 0 rows | live |
| 1.3 / 1.3b | read `inventory_sync_runs` | 0 rows; admin control ≥ 1 | live |
| 1.4 | read `profiles` | exactly 1 row (own) — real users exist and are invisible | live |
| 1.5 / 1.5b | `UPDATE inventory` on `KYV-0001` | 0 rows, unchanged; identical UPDATE as admin affects 1 | live |
| 1.6 | `INSERT INTO inventory` | `42501` | live |
| 1.7 / 1.7b | `DELETE FROM inventory` on `KYV-0002` | 0 rows, survives; admin control destroys it | live |
| 1.8 / 1.8b | `INSERT INTO commitments` directly | `42501` for rep **and** admin | live |
| 1.9 | `UPDATE commitments` | `42501` | live |
| 1.10 / 1.11 | `v_inventory` and `commitments` as `anon` | `42501` | live |
| 1.12 | `v_inventory` carries `security_invoker` | present in the migration source | **STATIC** |

`1.12` cannot run live: `pg_class` is not exposed over PostgREST. It is restated as a labelled
grep of `supabase/migrations/0008_inventory_view.sql`. **No live proxy for it exists over this
channel and none is invented.** The deployed-view check runs under `npm run verify:local`.

### `verify/hosted/02-quickbooks-sole-source.mjs` — attack 2

QuickBooks is the only source of committed. Figures are read through `v_inventory` with the rep
session and compared with a service-role read of `inventory`; syncs run through the
`apply_inventory_sync` RPC with the admin session; every forbidden action is issued directly at
PostgREST and asserted by its error code.

| # | What is done | Expected | Bucket |
|---|---|---|---|
| 2.1 | rep reads every KYV row through `v_inventory` | `qty_committed` equals `inventory.qty_committed` on every row | live |
| 2.2 | same read, `KYV-0004` at on hand 1 / committed 3 | `qty_available = on_hand − committed` everywhere; `KYV-0004` reads −2, not clamped | live |
| 2.3 | admin sync: `KYV-0006` committed 10 → 25 | rep sees committed 25, available 15 | live |
| 2.4 | `record_commitment` RPC as rep and admin | gone: `PGRST202` (or `42883`) | live |
| 2.5 | `INSERT` / `UPDATE` / `DELETE` on `commitments` as rep and admin | all six `42501` | live |
| 2.6 | admin sync with a non-empty `matches` array | `KY016` | live |
| 2.7 | rep calls `apply_inventory_sync` | `KY003`; row unchanged | live |
| 2.8 | admin syncs `KYV-0007` (override pre-attributed to the rep) with committed 9 | on hand kept, committed 9, `override_by`/`override_at` unchanged | live |
| 2.8b | admin `PATCH`es `override_by` to itself | accepted, attribution unchanged | live |
| 2.9 | admin `INSERT INTO inventory` with and without `qty_committed` (`KYV-0008`) | with: `42501`; without: succeeds at committed 0 | live |

Every assertion is live on both paths. `2.8` on hosted has one admin session, so "a user other
than the author" is the rep, whose attribution is set by `service_role` (which has no
`auth.uid()`, so the trigger leaves it as supplied); locally a second admin identity runs the
sync. The property asserted is the same: a sync never re-credits a correction to whoever ran it.

### Attack 3 — retired

"Delta survives a stale baseline" is retired with `0025`. It proved a pending portal commitment
kept reducing availability until an explicit match retired it. The portal no longer records
commitments and `apply_inventory_sync` no longer processes matches, so there is nothing left
for it to attack. `verify/hosted/03-stale-baseline.mjs` and `verify/03-stale-baseline.mjs` are
deleted; the number is not reused.

### `verify/hosted/04-role-enforcement.mjs` — attack 4

Every admin-only action is invoked directly as a `rep`, at the layer the plan claims enforces
it. **4.1–4.8 bypass the route handlers entirely, on purpose** — hiding a button is not access
control and is not tested here.

`4.12` re-runs three of them as `admin` and asserts they **succeed**. It is not optional:
without it, a build that refused everything for everyone would pass 4.1–4.11 and be reported
as secure.

**`4.12b` is the one genuinely dangerous control**, and it is written to be safe. `app_settings`
is a singleton with no disposable copy. It reads the current `inventory_authority` and
`PATCH`es **that same value**, asserting 1 row affected. The affected-row count is 1 whether or
not the value changed, so the policy is proven exactly as strongly, with no state change, no
restore window, and nothing left wrong if the harness is killed mid-run. The `WHERE` clause is
**identical** to the rep's attempt in 4.4 (`id=eq.true`) — that is the evidential point, and it
is preserved. Only the SET value differs, in the direction that changes nothing.

**`4.10` and `middleware.ts`.** `middleware.ts` matches `/api/*` and runs **before** the route
handler. With a session it passes the request through, so `4.9` reaches `requireAdmin()` and
the route's own 403 answers. With **no** session it redirects to `/login`, so the route's 401
is never reached. That redirect *is* the refusal. `4.10` therefore accepts either form, prints
which one it observed, and corroborates it with the thing that actually matters: **no
`inventory_sync_runs` row appeared** while the unauthenticated request was in flight. The
harness uses `redirect: 'manual'` so the redirect is visible rather than followed, and builds
the no-session request from a bare `fetch` with no inherited headers object — deleting a key
from a shared object is not the same thing.

---

## `npm run verify:local` — kept, demoted, relabelled

```
npm run verify:local
```

Stands up an ephemeral local PostgreSQL server via `embedded-postgres`, applies the shim and
the committed migrations, and runs attacks 1, 2 and 4. Its superuser password is generated
at runtime with `crypto.randomBytes` and is never written to disk or to the repo.

It survives because it is the only place that can inspect a deployed object directly (`1.12`)
and grant `anon` `EXECUTE` on a disposable database to prove the role guard on its own
(`4.13`). The shim also stubs the `storage` tables (`0015`, `0023`) and `cron.schedule` /
`cron.unschedule` (`0018`); the embedded server has no `pg_cron`, so the harness drops `0018`'s
`CREATE EXTENSION … pg_cron` on this path only and says so in the run header.
Its banner and summary both carry, verbatim:

```
  SCOPE: POLICY LOGIC ONLY.
  This run exercises RLS policy logic, function guards and concurrency control against an
  ephemeral local PostgreSQL server. It sets request.jwt.claims directly.
  It does NOT cover: identity issuance, JWT signing, JWT verification, PostgREST request
  handling, or session handling. Those are GoTrue's and PostgREST's job and are exercised
  only by `npm run verify` against the configured hosted project.
  A pass here must never be reported as a claim about the hosted project.
```

`npm run verify` never selects this path and never falls back to it. There is no Supabase-CLI
or docker detection branch: there is no supabase CLI in this environment, and a detection
branch that can never fire is how a future reader concludes the option exists.
`VERIFY_DATABASE_URL` still selects your own local Postgres, and the shim
(`verify/shim/00_auth_shim.sql`) is applied first — it is **not** a migration and must never be
pasted into the hosted SQL editor.

### The loopback guard

`bootstrap()` in `verify/lib/harness.mjs` begins with `DROP SCHEMA IF EXISTS public CASCADE`.
Pointed at the hosted project that destroys the client's entire application schema,
irreversibly, with no rollback and no confirmation. It is guarded: **the connection URL must
resolve to a loopback host (127.0.0.0/8, `localhost`, `::1`) or nothing is issued at all.** The
guard throws before the first query, not after. Nothing under `verify/hosted/**` imports this
module, and the module graph of `verify/run-all.mjs` does not contain it.

---

## What still cannot be verified

Stated plainly rather than papered over.

- **Magic-link email delivery.** The harness bypasses email by design — that is what makes
  unattended verification possible — so it proves nothing about whether a link actually
  arrives. Only a Human signing in can confirm that.
- **`pg_catalog` assertions against hosted.** `1.12` is `STATIC` there; it runs live under
  `verify:local`. Since `0025` no remaining assertion needs an open transaction.
- **Deployed function and view bodies.** `pg_get_functiondef` and `pg_class` are not exposed.
  The `STATIC` checks assert the migration source; `verify:local` asserts a deployed object,
  but a locally deployed one.
- **Netlify deployment and the public URL.** Deploy is a push, and pushing is a Human action.
- **Real Web Push.** Out of scope by the brief; nothing to verify.

The hosted project's actual RLS state is **no longer** on this list. It becomes verifiable the
moment the Human applies the migrations, which is what this harness is for.

---

## Not one of the attacks

```
npm run check:secrets
```

A repo-wide grep for key-shaped strings, plus a scan that fails on any line in `verify/` or
`scripts/` that both writes to stdout and reads `process.env`. Hygiene, not an attack: a grep
proves only that nothing key-shaped is checked in.

It also fails if any `.env` / `.env.local` file exists in the working tree. That is by design
for a clean checkout, but it does mean the check fails on a developer machine that has been
configured per `README.md` step 3 — move `.env.local` aside before running it.
