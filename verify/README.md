# Verification harness — the four required attacks

Four things in this build are most likely to be confidently wrong, and **all four fail
silently** — nothing in the UI reveals them. Rendering the page is not sufficient. Each is
actively attacked here, not merely exercised.

**Assertions run against a real database, never against mocks.** A mocked RLS policy proves
nothing; that is the whole point of these four.

```
npm run verify:preflight        # read-only. Creates nothing. Tells you what is missing
npm run verify:identities       # creates the two test identities on the hosted project
npm run verify                  # the four attacks, against the hosted project
npm run verify:identities:remove  # removes every artefact the above created
```

The ordered, zero-prior-context procedure — migrations, seed, users, the demo delta, and the
order they must go in — is in **`README.md`, "Running this against the hosted Supabase
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
| PostgREST `/rest/v1/rpc/…` | `record_commitment`, `apply_inventory_sync` |
| GoTrue `/auth/v1/…` | admin user creation, magic-link generation, OTP exchange, real signed JWTs |
| the running app over HTTP | `POST /api/commitments`, `POST /api/sync` — only when `PORTAL_BASE_URL` is set |

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

Migrations 0001–0012 are applied by hand. A first hosted run finds no tables at all, and
conflating that with a missing environment variable sends the reader to the wrong dashboard
page. The verdicts are distinct strings and are never substituted for one another:

```
NOT EXECUTED — no Supabase configuration
NOT EXECUTED — schema not applied
NOT EXECUTED — seed not applied
NOT EXECUTED — demo delta not applied, run order violated
NOT EXECUTED — test identities not provisioned (run npm run verify:identities)
```

A missing table surfaces from PostgREST as HTTP 404 with `code: 'PGRST205'`; the preflight
branches on that code, never on message text. It is read-only, creates nothing, and is also
available on its own as `npm run verify:preflight`.

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
session (`POST /api/commitments` with an impossible quantity → 409, so it writes nothing). If
it does not, the HTTP assertions report `NOT EXECUTED — rep session cookie not accepted by the
app` rather than FAIL.

---

## What this writes to the live project, and how it is bounded

**This is a deliberate departure from "the harness resets `SEA-9006` qty", and it is the safer
direction.** Against embedded Postgres every destructive statement ran inside a transaction
that rolled back. Over PostgREST there is no rollback: every request commits. Ported
literally, the admin-control assertions would permanently set `SEA-9006.qty_on_hand` to 9999,
permanently **delete** the `SEA-9006` inventory row, set `SEA-9007.qty_on_hand` to 4000, and
flip `app_settings.inventory_authority` to `portal` for the whole live portal.

**The rule instead:** every hosted statement that writes targets either (a) a harness-owned
disposable row in the KYV namespace, or (b) `app_settings`, written back to its own current
value. **No `SEA-*` row is mutated and the demo delta is read-only.**

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
| `KYV-0003` | 200 / 186 → available 14 | attack 1 setup commitments |
| `KYV-0004` | 1 on hand → **available exactly 1** | 2b 1-unit swarm, 2a.10 |
| `KYV-0005` | 3 on hand → available 3 | 2b 3-unit swarm |
| `KYV-0006` | 40 / 10 → available 30 | attack 3 |
| `KYV-0007` | `manual_override` contradicting the source | 3.11 |

**Per full run** it creates and deletes roughly 7 products, 7 inventory rows, on the order of
45 commitment rows and around a dozen `inventory_sync_runs` rows. **While they exist they are
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
whose table GRANT the role lacks — which is why every write to `commitments` raises. It does
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

## The four attacks, and what runs where

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

### `verify/hosted/02-concurrent-last-unit.mjs` — attack 2

20 unawaited HTTPS requests to the `record_commitment` RPC, against `KYV-0004` (availability
exactly 1) and then `KYV-0005` (3). They land on separate PostgREST backends and separate
Postgres connections; each takes the `FOR UPDATE` row lock in turn; the outcome is decided by
the database's serialisation, not by the client. `2b.0` records send and first-response
timestamps for every request and computes the peak number in flight, so the overlap is
evidenced rather than assumed.

Assertions: exactly 1 succeeds, exactly 19 refused `KY001`, every refusal message matches
`insufficient availability`, no other failure reason, exactly 1 pending row, `qty_available`
0. Repeated at 3 units: exactly 3 succeed, 17 fail — this catches an off-by-one a 1-unit test
would not.

**The residual gap, stated rather than glossed.** 2b proves the **outcome** is correctly
serialised. It does **not** provide direct evidence of **blocking**. "B's call is still
unsettled after 500 ms" is what distinguishes a correct lock from a lucky race, and it needs a
transaction held open across statements, which PostgREST does not have at any N. The honest
line, which the runner prints:

> serialisation outcome verified against hosted; blocking behaviour verified only under
> verify:local

`NOT EXECUTED` here: `2a.1`–`2a.9` (open transactions, `pg_locks`, `pg_stat_activity`,
`pg_blocking_pids`) and `2b.10` (needs a lock held across statements — without one there is
nothing to block behind, and a "fast second SKU" result would prove nothing while looking like
a pass). All run under `npm run verify:local`.

One environmental caveat, also printed: Supabase's PostgREST connection pool may be shallower
than the swarm size, so some requests may queue. The pass condition is exactly 1 (or exactly
3) winners regardless, but the observed peak is a lower bound on concurrency.

### `verify/hosted/03-stale-baseline.mjs` — attack 3

The oversell bug the project exists to prevent, on `KYV-0006` (40 on hand, 10 committed):

- a rep commits 6 → available drops 30 → **24**;
- a sync with the **same baseline** and **no matches** → still `pending`, still 24;
- five more identical syncs → still 24;
- a service-role `PATCH` of `created_at` is refused `KY006`, and so is `pending → retired`;
- a sync **with a real match** confirms it and `qty_available` **stays 24** — no double count,
  no upward blip, because the baseline write and the state change are one transaction;
- a qty disagreement is reported `match_fields_disagree` and it stays `pending`;
- an unknown id is reported `unknown_commitment` and nothing in the KYV namespace changes;
- syncing a `manual_override` row preserves its quantities and records what the source claimed.

**`commitments_still_pending` is project-wide, not payload-scoped.**
`0010_fn_apply_inventory_sync.sql:148` computes it as
`SELECT count(*) FROM public.commitments WHERE state = 'pending'`, unfiltered. On a hosted
project the demo delta and any prior harness rows inflate it, so `3.2c` is asserted as a
**delta** against a count read immediately beforehand. `commitments_confirmed`,
`rows_applied` and `overrides_preserved` count only this call's work and stay absolute.

`STATIC` here: `3.6a` and the six forbidden-pattern checks. `pg_get_functiondef` is not
exposed, so they grep `supabase/migrations/0010_fn_apply_inventory_sync.sql` — same six
patterns, same block isolation. The deployed-body check runs under `npm run verify:local`.

`NOT EXECUTED` here: `3.4`, `3.4b`, `3.5`, `3.5b`, `3.5c`. Establishing a 30-day-old
commitment requires `ALTER TABLE … DISABLE TRIGGER`; that is DDL, and DDL is unreachable over
PostgREST for anyone. Re-running the 3.2 sync and reporting those ids as passes would be a
false claim.

**Conditional:** `3.4a` and `3.7` depend on `service_role` retaining Supabase's default
`UPDATE` grant on `commitments` (`0012` revokes from `anon` and `authenticated` only). If the
observation is `42501` rather than `KY006`, that is a **missing grant**, which is a different
finding from a broken trigger — so it reports `NOT EXECUTED — service_role lacks the UPDATE
grant on commitments; the trigger was never reached (observed 42501)`, not FAIL.

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
the committed migrations, and runs the same four attacks. Its superuser password is generated
at runtime with `crypto.randomBytes` and is never written to disk or to the repo.

It survives because it is the only place attack 2a's deterministic lock interleaving can run.
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
- **Raw-SQL, open-transaction and `pg_catalog` assertions against hosted.** Listed per
  assertion above; all preserved under `verify:local`.
- **Deployed function and view bodies.** `pg_get_functiondef` and `pg_class` are not exposed.
  The `STATIC` checks assert the migration source; `verify:local` asserts a deployed object,
  but a locally deployed one.
- **Netlify deployment and the public URL.** Deploy is a push, and pushing is a Human action.
- **Real Web Push.** Out of scope by the brief; nothing to verify.

The hosted project's actual RLS state is **no longer** on this list. It becomes verifiable the
moment the Human applies the migrations, which is what this harness is for.

---

## Not one of the four

```
npm run check:secrets
```

A repo-wide grep for key-shaped strings, plus a scan that fails on any line in `verify/` or
`scripts/` that both writes to stdout and reads `process.env`. Hygiene, not an attack: a grep
proves only that nothing key-shaped is checked in.

It also fails if any `.env` / `.env.local` file exists in the working tree. That is by design
for a clean checkout, but it does mean the check fails on a developer machine that has been
configured per `README.md` step 3 — move `.env.local` aside before running it.
