# Verification harness — the four required attacks

Four things in this build are most likely to be confidently wrong, and **all four fail
silently** — nothing in the UI reveals them. Rendering the page is not sufficient. Each is
actively attacked here, not merely exercised.

**Assertions run against a real database, never against mocks.** A mocked RLS policy proves
nothing; that is the whole point of these four.

**Nothing here touches the hosted Supabase project.** No live credentials are needed and none
must be supplied.

```
npm install
npm run verify
```

Exit code 0 only if all four attacks pass.

---

## How it gets a database

`npm run verify` prints which path it used, because the answer changes what the results mean.

### Path A — Supabase CLI + Docker (strongest)

```
supabase start
npm run verify
```

Selected automatically when `supabase status -o json` succeeds. This gives the real thing:
the `auth` schema, real `auth.users`, real `auth.uid()`, real `anon` / `authenticated` /
`service_role` roles, and GoTrue. RLS behaves exactly as it will in production.

**Credential rule for Path A:** the local stack's keys are read at runtime from
`supabase status -o json` and are **never hardcoded, not even the well-known
local-development defaults.** A key-shaped string in the repo fails
`scripts/check-no-secrets.sh` regardless of whether it happens to be public.

### Path B — your own local Postgres

```
VERIFY_DATABASE_URL=postgresql://…@127.0.0.1:5432/postgres npm run verify
```

Applies `verify/shim/00_auth_shim.sql` before the migrations. Without the Supabase stack
there is no `auth` schema, no `auth.users`, no `auth.uid()` and none of the three roles, so
every migration would otherwise fail on the first foreign key to `auth.users(id)`.

The shim is **not** a migration and must never be pasted into the hosted SQL editor —
Supabase already provides all of it. `supabase/migrations/` contains only files a Human will
paste.

### Path B′ — an ephemeral Postgres the harness starts itself (the default)

With neither of the above available, the harness downloads and starts a real PostgreSQL
server on a loopback port via the `embedded-postgres` dev dependency, applies the shim and the
committed migrations to it, and tears it down at the end. This is a genuine PostgreSQL
server process, not a simulation — but it is not the Supabase stack, so the Path B caveat
below applies.

Its superuser password is generated at runtime with `crypto.randomBytes`, is never written to
disk, never logged and never committed.

### The Path B caveat, stated rather than papered over

Under Path B and B′ the harness asserts its own identity by setting the `request.jwt.claims`
GUC directly, exactly the way Supabase's own local RLS testing does:

```sql
BEGIN;
  SELECT set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  -- …the attack…
ROLLBACK;
```

`SET LOCAL ROLE` is what makes RLS apply. Without it the harness would run as the table owner,
every policy would be bypassed, and the result would be a set of false passes.

**Path B therefore proves the POLICIES are correct given an identity. It does NOT prove that
JWT signing, verification or session handling are correct** — those are GoTrue's job and are
exercised only under Path A and by manual sign-in against the deployed app. `run-all.mjs`
prints this caveat in its output whenever it runs under Path B, so a Path B pass is never
mistaken for a stronger claim than it is.

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
2. the target row is unchanged on an independent re-read, and
3. the **identical** statement, run as `admin`, affects ≥ 1 row.

(3) is what makes it a demonstration of the policy rather than of a broken statement — and it
is what stops a build that refuses everything for everyone from being reported as secure.

---

## The four attacks

### `01-rls-bypass.mjs` — attack 1

Signed in as a `rep`, every read and write is issued directly over SQL rather than through the
UI. An admin-session control run confirms the forbidden rows actually exist, so a refusal is
distinguished from an empty table.

| # | Attempt as `rep` | Expected |
|---|---|---|
| 1.1 | `SELECT * FROM commitments` | only own rows; the admin's is absent |
| 1.2 | select the admin's commitment **by id** | 0 rows — naming the row does not help |
| 1.3 | `SELECT * FROM inventory_sync_runs` | 0 rows, while the admin control returns ≥ 1 |
| 1.4 | `SELECT * FROM profiles` | exactly 1 row (own) |
| 1.5 | `UPDATE inventory SET qty_on_hand = 9999` | 0 rows, unchanged, admin control succeeds |
| 1.6 | `INSERT INTO inventory …` | refused, `42501` |
| 1.7 | `DELETE FROM inventory …` | 0 rows, row survives, admin control succeeds |
| 1.8 | `INSERT INTO commitments …` directly | refused, `42501` — **the one that would defeat attack 2** |
| 1.9 | `UPDATE commitments SET state='retired'` | refused, `42501` |
| 1.10 | `SELECT * FROM v_inventory` as `anon` | refused, `42501` |
| 1.11 | `SELECT * FROM commitments` as `anon` | refused, `42501` |
| 1.12 | `v_inventory` has `security_invoker` set | present — a default view is a full RLS bypass |

### `02-concurrent-last-unit.mjs` — attack 2

Two genuinely concurrent connections on `SEA-9006`, which the seed pins at availability
exactly 1.

**2a, deterministic interleaving.** A calls `record_commitment` and holds its transaction
open. B calls the same thing and **must block on A's row lock**. The harness waits 500 ms and
asserts B's promise is still unsettled — that is the direct evidence of serialisation, because
a naive read-then-write would have returned immediately with a success. It corroborates from
the server with `pg_blocking_pids`, and checks that the blocked backend holds `RowShareLock`
on `inventory` while waiting on a row-level lock. A then commits and B is observed to fail
with `KY001`.

**2b, stochastic swarm.** 20 connections fire `Promise.all` at a 1-unit SKU: exactly 1
succeeds, exactly 19 are refused `KY001`, exactly 1 pending row, `qty_available` 0. Repeated
at 3 units: exactly 3 succeed, 17 fail — this catches an off-by-one a 1-unit test would not.
A final case proves a commitment on a **different** SKU does not block behind the held lock,
so the lock is genuinely row-scoped.

**Failure of this test is a design failure, not a flake.** If it fails, the fix belongs in
`record_commitment`, not in the test.

### `03-stale-baseline.mjs` — attack 3

The oversell bug the project exists to prevent. On `SEA-9007` (40 on hand, 10 committed):

- a rep commits 6 → available drops 30 → **24**;
- a sync arrives with the **same baseline** and **no matches** → still `pending`, still 24;
- five more identical syncs → still 24;
- the commitment's `created_at` is forcibly aged **30 days** → still 24. Elapsed time changes
  nothing. (The lifecycle trigger refuses to rewrite `created_at` even for the table owner,
  which is asserted first; the harness disables the trigger to simulate ageing and says so.)
- the deployed function body is read back from `pg_get_functiondef` and its retirement block
  asserted to contain no `interval`, no `age(`, no `now() -`, no `current_date`;
- `pending → retired` is refused with `KY006` even for a privileged caller;
- a sync **with a real match** confirms the commitment and `qty_available` **stays 24** — no
  double count and no upward blip, because the baseline write and the state change happen in
  the same transaction;
- a qty disagreement is reported `match_fields_disagree` and the commitment stays `pending`;
- an unknown id is reported `unknown_commitment` and nothing is altered;
- syncing a `manual_override` row preserves its quantities and records what the source claimed
  in `source_payload.last_source_snapshot`.

### `04-role-enforcement.mjs` — attack 4

Every admin-only action is invoked directly as a `rep`, at the layer the plan claims enforces
it. **4.1–4.8 bypass the route handlers entirely, on purpose** — hiding a button is not access
control and is not tested here.

`4.12` re-runs three of them as `admin` and asserts they **succeed**. It is not optional:
without it, a build that refused everything for everyone would pass 4.1–4.11 and be reported
as secure.

---

## What is NOT run here

Stated plainly rather than papered over. These print as **SKIP**, never as PASS.

| Assertion | Why |
|---|---|
| `2a.10` — `POST /api/commitments` → 409 `INSUFFICIENT_AVAILABILITY` | needs a running app server *and* a live Supabase/PostgREST endpoint for it to talk to |
| `4.9` — `POST /api/sync` with a rep session → 403 | same |
| `4.10` — `POST /api/sync` with no session → 401 | same |

To run them, stand up Path A, start the app against it, and set:

```
PORTAL_BASE_URL=http://127.0.0.1:3000 PORTAL_REP_COOKIE='<the rep session cookie>' npm run verify
```

The database-level refusals underneath all three (`KY001` from `record_commitment`, `KY003`
from `apply_inventory_sync`) **are** executed for real. The plan states the database layer is
the authoritative one; the route guards exist to return a clean 403/401 instead of a 500.

Also outside this harness entirely:

- **Magic-link email delivery** — requires a real mail send from the hosted project.
- **The hosted project's actual RLS state** — the migrations are written, not applied. This
  harness proves the *migrations* produce correct policies; it cannot prove the hosted database
  has them until the Human pastes them in.
- **Netlify deployment** — deploy is a push, and pushing is a Human action.
- **Real Web Push** — out of scope by the brief; nothing to verify.

---

## Not one of the four

```
npm run check:secrets
```

A repo-wide grep for key-shaped strings. Hygiene, not an attack: it proves only that nothing
key-shaped is checked in.
