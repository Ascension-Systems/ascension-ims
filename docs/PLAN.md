# PLAN — Ascension Sales Portal, Build-Order Step 1

**Author:** Starter (Phineas domain) · **Date:** 2026-08-19
**Source of truth:** `BRIEF-ascension-sales-portal.md`, including Human decisions D1–D8 (settled).
**Build location:** `projects/ascension-portal/` — its own git repository. Nothing outside it.
**Status:** build-ready.

## This plan is four documents

| Document | Contents |
|---|---|
| **`PLAN.md`** (this file) | Scope, out-of-scope, constraints, file tree, the four D7 mechanisms, build sequence, decisions |
| **`SCHEMA.md`** | Migrations `0001`–`0008`: types, tables, constraints, indexes, the availability view |
| **`FUNCTIONS-AND-POLICIES.md`** | Migrations `0009`–`0012`: the atomic commit function, the sync procedure, every RLS policy as SQL, grants |
| **`UI-AND-APP.md`** | Auth flow, the QuickBooks adapter, authority modes, the inventory view, status encoding, seed generator |

Builder reads all four before writing code. They do not overlap; each requirement is stated
in exactly one place.

---

## 1. Project summary

A real, deployed, authenticated sales portal for a furniture business's ~120 external sales
reps. Reps sign in with a magic link and see a searchable, filterable inventory list showing
on-hand, committed, available and incoming quantities, with source attribution and freshness.

The number a rep acts on is **available**, not on-hand. Showing on-hand alone is what causes
selling stock that is already spoken for — the bug this project exists to prevent.

QuickBooks is not accessible yet. It is stubbed behind a single adapter module so the only
thing that changes at cutover is *who writes the inventory rows*.

### What this run builds (D8)

Build-order **step 1 only**: auth + inventory view + seed data. It must stand alone as a
demoable artifact: sign in → searchable/filterable inventory list with
on-hand / committed / available / incoming and freshness.

### The one deliberate carve-out

All four verification requirements (brief lines 184–205) must be attackable by Ferb in this
run. Two of them concern the commitments ledger, nominally step 2. Settled resolution:

- **The full commitments data layer ships** — the table, the
  `pending → confirmed_in_source → retired` lifecycle as schema, RLS on it, the
  state-transition trigger, and the server-side atomic commit operation with real
  concurrency control.
- **No step-2 UI ships.** No "record a commitment" button, form, screen, link or
  placeholder. The operation is reachable server-side only — a Postgres RPC plus one route
  handler. Nothing rendered navigates to it.
- **The inventory view does display `committed`** and the show-both-numbers delta
  presentation, because that is step 1's centrepiece and it needs the ledger to compute
  against.

---

## 2. OUT OF SCOPE FOR THIS RUN

Builder must not build, stub, placeholder, or link to any of the following. Their absence is
not a defect and must not be reported as one.

| Not in this run | Status |
|---|---|
| **Step 2 UI** — rep commitment recording screen, form, button, "record a sale" flow | Approved in principle (D1), HELD (D8) |
| **Step 3 UI** — admin inventory editing, override editing, reconciliation view / backlog list | Approved in principle (D1), HELD (D8) |
| **Promotions** (build-order 4) | Approved in principle, not this run (D1) |
| **Document library** (build-order 5) | Approved in principle, not this run (D1) |
| **Notification centre** (build-order 6) | Approved in principle, not this run (D1) |
| Real Web Push — service worker push, VAPID, permission prompt | Out of scope per brief |
| QuickBooks / Rightworks / Conductor real integration | No client access |
| Dropbox, SharePoint, Office 365 | Nothing touches these |
| Order entry / write-back to QuickBooks | Deliberately later, priced separately |
| Multi-location UI — site pickers, per-site filters | Column exists in schema; no UI (D4 #3) |
| Commitment cancellation or editing | Step 3. See §8 deferred decisions. |
| Scheduled/automatic sync jobs | Sync is manual via `POST /api/sync` in this run |
| Password auth, password reset, credential storage | Forbidden — magic link only |
| Any brand hue, accent colour, logo, or company name | Forbidden by D2 |

**No "coming soon" placeholders anywhere.** If a user cannot do it in step 1, the interface
does not mention it.

---

## 3. Stack — decided, do not re-litigate

- **Next.js (App Router)** + **TypeScript** (strict)
- **Supabase** — Postgres + Auth, via `@supabase/supabase-js` and `@supabase/ssr`
- **Magic-link passwordless auth.** No password fields, no reset flow, no credential storage.
- **Netlify** hosting (`@netlify/plugin-nextjs`); deploys on push to `main` — a Human action.
- **PWA installable** — manifest + icons + a minimal fetch-passthrough service worker. Real
  Web Push is out of scope; do not fake a notification permission prompt.
- **Styling: plain CSS.** `app/globals.css` for design tokens, `*.module.css` per component.
  No Tailwind, no CSS-in-JS. The achromatic token set (D2) must live in one auditable place
  so downstream `ui` reads tokens rather than hunting utility classes, and it adds no
  toolchain.
- **Mobile-first is the single most important non-functional requirement.** Demoed on a
  phone; find-what-you-need in under three taps. Design at 375×667 and widen. Never a desktop
  table that shrinks.

---

## 4. Infrastructure constraints — NON-NEGOTIABLE

Hard rules. Builder must not work around any of them, and must not report a task blocked in a
way that requires breaking one.

1. **Never ask for, and never accept, an API key, token or password.** A token was pasted in
   a previous session, treated as compromised, and revoked. If a step appears to need a real
   credential, stop and report it instead of asking.
2. **`.env.example` carries variable NAMES with EMPTY VALUES only.** Exactly:
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   ```
   No example values, no placeholder-looking strings, no comments containing anything
   key-shaped.
3. **`SUPABASE_SERVICE_ROLE_KEY` must never reach the browser.** Never prefix it
   `NEXT_PUBLIC_`. `process.env.SUPABASE_SERVICE_ROLE_KEY` appears in application code in
   exactly one file: `lib/supabase/admin.ts`, which begins `import 'server-only'`. It may be
   imported only from `app/api/**` and `lib/inventory-source.stub.ts`, enforced by a
   `no-restricted-imports` rule in `.eslintrc.json`. `scripts/*.mjs` and `verify/*.mjs` read
   the variable directly; neither is ever bundled.
4. **Migrations are WRITTEN, NEVER APPLIED.** Versioned SQL into `supabase/migrations/`.
   **No step in this build connects to, authenticates against, or runs anything on the hosted
   Supabase project (ref `rakslwwxduovcqnuercz`).** The Human pastes each file into the SQL
   editor so a person reads every schema change. The hand-off lists pending migrations in
   order.
5. **Commit, never push.** `git init` in the build directory, `main` branch, commit freely.
   No `git remote add`, no `git push`, no remote configuration of any kind.
6. **No secrets in the repo. No credentials anywhere in seed data** — including
   plausible-looking placeholder passwords, keys or tokens. Not even fake ones. Magic-link
   auth means there are no passwords to placeholder in the first place; there must be none.
   Email addresses in seed and verification data use the reserved, non-routable
   `example.invalid` domain.
7. The build directory is **its own git repository** with its own `.gitignore` (§5).

### Risk level — stated, not inferred (D5)

**This build is internet-facing and multi-user: ~120 external users, real authentication, a
public URL backed by a real database.** "Demo-only" (D3) describes who is invited, not how
exposed it is. RLS is enabled on **every** table with policies written; role enforcement lives
in the database, not in the UI. A Supabase project with RLS off and the anon key in a frontend
is a fully public database — the first thing a pen test finds, and a pen test is scheduled
before sale.

### Error-code mapping — `lib/errors.ts`

Route handlers branch on the SQLSTATE (`PostgrestError.code`), **never** on message text.

| SQLSTATE | Meaning | HTTP | Client body `error` |
|---|---|---|---|
| `KY001` | Insufficient availability (lost the race, or asked for more than exists) | 409 | `INSUFFICIENT_AVAILABILITY` |
| `KY002` | Not authenticated | 401 | `NOT_AUTHENTICATED` |
| `KY003` | Admin role required | 403 | `FORBIDDEN_ROLE` |
| `KY004` | Invalid input | 400 | `INVALID_INPUT` |
| `KY005` | Unknown sku/location | 404 | `UNKNOWN_SKU_LOCATION` |
| `KY006` | Illegal commitment transition / immutable field | 409 | `ILLEGAL_TRANSITION` |
| `42501` | RLS or grant refusal | 403 | `FORBIDDEN` |
| anything else | — | 500 | `INTERNAL` (details logged server-side, never returned) |

---

## 5. File and directory tree

Relative to `/Users/calebjaworski/kyrie-pipeline/projects/ascension-portal/`.

```
.gitignore                       Repo hygiene; contents below
.env.example                     Variable names, empty values, nothing else
.eslintrc.json                   next/core-web-vitals + no-restricted-imports for the admin client
README.md                        What this is, how to run it, how to run the verification harness
package.json                     Deps + scripts (dev/build/seed:generate/verify)
tsconfig.json                    Strict TS, @/* path alias
next.config.mjs                  Minimal; reactStrictMode
netlify.toml                     Build command + @netlify/plugin-nextjs
middleware.ts                    Session refresh + unauthenticated redirect; matcher excludes assets

docs/PLAN.md                     This document
docs/SCHEMA.md                   Migrations 0001-0008
docs/FUNCTIONS-AND-POLICIES.md   Migrations 0009-0012
docs/UI-AND-APP.md               Application layer
docs/VERIFICATION.md             Local DB paths + the four attacks

app/layout.tsx                   Root html/body, viewport-fit=cover, theme-color, SW registration
app/globals.css                  Achromatic tokens, reset, type scale, tap-target sizes
app/manifest.ts                  Web app manifest (Next metadata route)
app/page.tsx                     "/" -> /inventory (signed in) or /login
app/login/page.tsx               Email-only magic-link request form
app/login/actions.ts             Server action: signInWithOtp, shouldCreateUser:false
app/login/check-email/page.tsx   Neutral confirmation screen (no user enumeration)
app/auth/callback/route.ts       Handles both `code` (PKCE) and `token_hash` returns
app/auth/auth-code-error/page.tsx  Expired/invalid link message, link back to /login
app/signout/route.ts             POST-only sign out
app/inventory/page.tsx           RSC: requireUser -> settings -> v_inventory -> render
app/inventory/loading.tsx        Static skeleton rows (no animation)
app/api/commitments/route.ts     POST -> record_commitment RPC. NO UI POINTS AT THIS.
app/api/sync/route.ts            POST -> adapter + apply_inventory_sync. Admin only.

components/inventory-list.tsx    Client: search + filter + sort over the full row set
components/inventory-row.tsx     One product card; tap to expand in place (no detail route)
components/availability-block.tsx  Show-both-numbers presentation; authority-mode aware
components/status-badge.tsx      Multi-channel stock status encoding
components/stale-badge.tsx       Additive freshness marker, orthogonal to stock status
components/relative-time.tsx     Absolute on server, relative after mount, 60s tick
components/search-field.tsx      56px search input
components/filter-bar.tsx        Category + status chips, 44px tall, scrollable
components/sign-out-button.tsx   Posts to /signout
components/icons.tsx             Inline SVG status glyphs (square, triangle, arrow, slashed circle, clock)
components/*.module.css          Scoped styles alongside the above

lib/supabase/client.ts           createBrowserClient (anon key only)
lib/supabase/server.ts           createServerClient bound to next/headers cookies
lib/supabase/middleware.ts       updateSession helper
lib/supabase/admin.ts            Service-role client. `import 'server-only'`. Restricted importers.
lib/auth.ts                      getUser / getProfile / requireUser / requireAdmin
lib/inventory-source.ts          THE ADAPTER: InventoryRow type + fetchInventory() contract
lib/inventory-source.stub.ts     Stub implementation; echoes current source-of-record rows
lib/inventory.ts                 Typed query helpers over v_inventory
lib/settings.ts                  Reads app_settings (authority, thresholds)
lib/status.ts                    Stock-status + staleness derivation; pure, unit-testable
lib/relative-time.ts             formatRelativeAge(iso, now); pure
lib/errors.ts                    SQLSTATE -> HTTP mapping (table in §4)
lib/types.ts                     Shared row/DTO types

public/icon-192.png              Achromatic app icon
public/icon-512.png
public/icon-maskable-512.png
public/apple-touch-icon.png
public/sw.js                     Minimal SW: network passthrough, no cache, no push

supabase/config.toml             Local Supabase CLI config (local stack only)
supabase/migrations/0001_extensions_and_enums.sql
supabase/migrations/0002_profiles_and_role_helpers.sql
supabase/migrations/0003_products.sql
supabase/migrations/0004_inventory.sql
supabase/migrations/0005_commitments.sql
supabase/migrations/0006_app_settings.sql
supabase/migrations/0007_inventory_sync_runs.sql
supabase/migrations/0008_inventory_view.sql
supabase/migrations/0009_fn_record_commitment.sql
supabase/migrations/0010_fn_apply_inventory_sync.sql
supabase/migrations/0011_rls_policies.sql
supabase/migrations/0012_grants.sql
supabase/seed/0001_seed_catalogue.sql    GENERATED - 90 catalogue SKUs + inventory rows
supabase/seed/0002_seed_fixtures.sql     GENERATED - the pinned fixtures
supabase/seed/0003_seed_demo_delta.sql   Hand-written; demo commitment + override author

scripts/generate-seed.mjs        Deterministic seed generator
scripts/generate-icons.mjs       Deterministic achromatic PNG icons
scripts/check-no-secrets.sh      Repo-wide grep for key/token/password shapes (hygiene, not an attack)

verify/README.md                 How to stand up a local DB and run the four attacks
verify/shim/00_auth_shim.sql     LOCAL-ONLY auth shim for the plain-psql fallback path
verify/lib/harness.mjs           Connection helpers, asRep/asAdmin/asAnon, assert + PASS/FAIL output
verify/00-setup.sql              Two identities + deterministic test rows
verify/01-rls-bypass.mjs         Attack 1
verify/02-concurrent-last-unit.mjs  Attack 2
verify/03-stale-baseline.mjs     Attack 3
verify/04-role-enforcement.mjs   Attack 4
verify/run-all.mjs               Runs 01-04, prints pass/fail with method per attack
```

### `.gitignore`

```
node_modules/
.next/
out/
build/
.env
.env.*
!.env.example
.DS_Store
*.log
npm-debug.log*
.netlify/
.vercel/
supabase/.temp/
supabase/.branches/
coverage/
verify/.out/
*.tsbuildinfo
```

---

## 6. The four D7 mechanisms — stated concretely

Front-loaded so Builder implements these **deliberately** rather than arriving at them by
accident. Full SQL in the companion documents; the mechanism itself is stated here.

### 6.1 RLS bypass — the policy predicates

**Role lives in `public.profiles.role`** (enum `app_role`), in the database. It is never read
from anything the client sends: not a request body, header, `localStorage`, query parameter,
or custom JWT claim. The only trusted input is `auth.uid()`, derived by PostgREST from the
Supabase-signed JWT.

Policies read it through `public.is_admin()`, which wraps `public.app_role()`. **Both are
`SECURITY DEFINER`** — mandatory, because they are called from inside the policies on
`profiles` itself, and a `SECURITY INVOKER` function would recurse (`42P17`).

RLS is enabled in each table's own creating migration, so a table never exists without it.
Policies arrive in `0011`; until then every table is deny-all. `FORCE ROW LEVEL SECURITY` is
deliberately **not** used — the `SECURITY DEFINER` write path depends on the owner bypass.

Predicates (all `TO authenticated`; `anon` gets no policies and, per `0012`, no grants):

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `profiles` | `id = auth.uid() OR public.is_admin()` | *(none)* | `public.is_admin()` | *(none)* |
| `products` | `true` | `public.is_admin()` | `public.is_admin()` | `public.is_admin()` |
| `inventory` | `true` | `public.is_admin()` | `public.is_admin()` | `public.is_admin()` |
| `commitments` | `rep_id = auth.uid() OR public.is_admin()` | **(none — deliberate)** | **(none — deliberate)** | **(none — deliberate)** |
| `app_settings` | `true` | *(none)* | `public.is_admin()` | *(none)* |
| `inventory_sync_runs` | `public.is_admin()` | *(none)* | *(none)* | *(none)* |

`commitments` has **exactly one policy**. An INSERT policy would let a rep write a row
directly and skip the availability check inside `record_commitment()`, making the concurrency
control trivially bypassable. Every write goes through the `SECURITY DEFINER` function. Direct
writes fail with `42501`, for admins too.

Two supporting mechanisms that are part of this requirement, not extras:

- **`v_inventory` is created `WITH (security_invoker = on)`.** A Postgres view runs as its
  *owner* by default, so a default view over these tables would be a complete RLS bypass
  reachable with the anon key. Attack 1.12 asserts the option is actually set.
- **Grants are the other half of the gate.** `0012` revokes all from `anon` and
  `authenticated`, then re-grants the minimum per table, and revokes `EXECUTE` from `PUBLIC`
  on every function (functions are granted to `PUBLIC` by default — the most commonly missed
  line in a Supabase hardening pass).

Full SQL: `FUNCTIONS-AND-POLICIES.md` §3–§4.

### 6.2 Concurrent commitment on the last unit — the concurrency control

**Mechanism: `SELECT … FOR UPDATE` on the `inventory` row, inside a `SECURITY DEFINER`
plpgsql function (`record_commitment`), exposed as a PostgREST RPC.**

The lock is taken on `inventory(sku, location)` — the exact contended resource — **before**
availability is read. Availability is then recomputed *inside* the lock from the base tables.
Concurrent callers for the same SKU serialise; different SKUs never block each other.

Chosen over the alternatives, with reasons:

- **Not serializable isolation** — `SET TRANSACTION ISOLATION LEVEL` must be the first
  statement in a transaction, and a PostgREST-invoked function's transaction has already
  begun, so the function cannot set it. It would also surface as `40001` and oblige every
  caller to implement retry logic.
- **Not a CHECK constraint on a derived total** — a CHECK cannot reference other rows, so it
  would require a denormalised counter maintained by a trigger: same guarantee, a second
  source of truth for a derivable number.
- **Not an advisory lock** — `hashtext` collisions make unrelated SKUs contend, and, deciding
  the matter, an advisory lock does **not** conflict with a plain `UPDATE` of the inventory
  row, so a sync writing a new baseline would run straight through it. `FOR UPDATE` takes the
  real row lock the sync also needs, serialising commit-versus-sync as well as
  commit-versus-commit.

**Forbidden: reading availability from `v_inventory` (or from the client) and then
inserting.** A naive read-then-write passes every single-user test and fails this one; if it
ships, that is a failure of this plan, not of the build.

`record_commitment` takes **no `rep_id` parameter** — identity comes from `auth.uid()` inside
the function, which is what stops a `SECURITY DEFINER` function from becoming an RLS bypass.

**What the losing session is told.** Database: SQLSTATE **`KY001`**, message
`insufficient availability for SEA-9006 at default: requested 1, available 0`.
`app/api/commitments/route.ts` maps it to **HTTP 409** with
`{"error":"INSUFFICIENT_AVAILABILITY","message":"Only 0 available — another rep committed the
last unit first.","sku":…,"requested":…,"available":…}`, branching on `error.code === 'KY001'`,
never on message text.

Full SQL: `FUNCTIONS-AND-POLICIES.md` §1.

### 6.3 Delta survives a stale baseline — lifecycle and matching

Lifecycle as schema: `pending → confirmed_in_source → retired`, enforced by a `BEFORE UPDATE`
trigger that permits **only** those two transitions and rejects everything else with `KY006`,
including `pending → retired`, `confirmed_in_source → pending`, `retired → anything`, and any
edit to `sku`/`location`/`qty`/`rep_id`/`created_at`.

Only `pending` reduces `available`. `confirmed_in_source` does not — the synced baseline's own
`qty_committed` now includes it, and counting both would double-count. The baseline write and
the state change happen **in the same transaction** inside `apply_inventory_sync`; separating
them would open a window where neither counts and `available` briefly jumps up.

**Retirement is triggered by matching only. Nothing time-based.** A pending commitment becomes
`confirmed_in_source` only when the sync payload contains a `matches` entry satisfying **all**
of:

```
match.commitment_id = commitments.id
match.sku           = commitments.sku
match.location      = commitments.location
match.qty           = commitments.qty
commitments.state   = 'pending'
```

Anything else is recorded in the run report as `match_fields_disagree` or
`unknown_commitment`, and the commitment stays `pending`.

**Matching is explicit and never inferred.** There is no quantity-absorption heuristic — the
function never reasons "the source's committed figure rose by 6, so retire six units' worth of
the oldest pending commitments." That heuristic retires the wrong commitments the moment two
reps commit the same SKU.

**What happens to a commitment a sync does not mention: it persists, unchanged, in `pending`,
and keeps reducing `available`, for as long as that takes.** No time limit, no expiry, no
grace period, no "the sync ran and found no match, so it must be gone." This is the default
rather than a special case, because the function only ever touches commitments named in
`matches`. There is no `now()`, no `interval`, no `age()` and no date comparison anywhere in
the retirement path, and attack 3.6 asserts that statically. The `pending → retired` ban is
the structural backstop: even a careless future cron job cannot retire a live delta in one
step.

Nothing in this run sets `retired`. The transition exists and is legal from
`confirmed_in_source`; no code path reaches it until step 3.

Full SQL: `SCHEMA.md` §5 (lifecycle + trigger), `FUNCTIONS-AND-POLICIES.md` §2 (sync).

### 6.4 Server-side role enforcement — where each check lives

Hiding a button is not access control and is not counted here.

| Admin-only action | Enforcing layer |
|---|---|
| Edit inventory quantities | RLS `inventory_update_admin` — **database** |
| Create / edit / delete products | RLS `products_*_admin` — **database** |
| Change `inventory_authority` or thresholds | RLS `app_settings_update_admin` — **database** |
| Read sync history | RLS `sync_runs_select_admin` — **database** |
| Run an inventory sync | `is_admin()` guard **inside** `apply_inventory_sync` (`SECURITY DEFINER` function), **and** `requireAdmin()` in `app/api/sync/route.ts`. Two layers; the database one is authoritative. |
| Change a user's role | RLS `profiles_update_admin` — **database** |
| Write a commitment row directly | No policy exists, for any role — **database** |
| Record a commitment | `SECURITY DEFINER` function; identity from `auth.uid()`, no `rep_id` parameter |

Route-handler guards exist to return a clean 403 instead of a 500. They are **not** the access
control — every one has a database refusal underneath it, and attacks 4.1–4.8 bypass the route
handlers entirely to prove it. Middleware is likewise convenience, not a gate.

One pairing must stay intact: `apply_inventory_sync` permits a NULL `auth.uid()` so
`service_role` can run unattended, and that branch is only safe because `EXECUTE` is revoked
from `anon`, whose `auth.uid()` is also NULL. Granting `anon` execute would open the guard.

Full detail: `VERIFICATION.md` §6.

---

## 7. Build sequence, in dependency order

1. **Repo skeleton.** `git init`; `.gitignore`, `.env.example` (empty values), `package.json`,
   `tsconfig.json`, `next.config.mjs`, `netlify.toml`, `.eslintrc.json`. Commit.
2. **Migrations `0001`–`0012`**, in order, exactly as specified in `SCHEMA.md` and
   `FUNCTIONS-AND-POLICIES.md`. Write them; **do not apply them to anything hosted.** Commit.
3. **Seed generator** (`scripts/generate-seed.mjs`) + run it + commit both the script and its
   output (`supabase/seed/0001`, `0002`). Hand-write `0003_seed_demo_delta.sql`. Commit.
4. **Local database + verification harness.** `verify/shim/00_auth_shim.sql`,
   `verify/lib/harness.mjs`, `00-setup.sql`, then attacks `01`–`04` and `run-all.mjs`.
   **Run them and make them pass before building any UI.** If the concurrency control or a
   policy is wrong, it is far cheaper to find out now than after the interface exists.
5. **Supabase clients + auth.** `lib/supabase/*`, `lib/auth.ts`, `middleware.ts`, `/login`,
   `/login/check-email`, `/auth/callback`, `/auth/auth-code-error`, `/signout`. Commit.
6. **Adapter + route handlers.** `lib/inventory-source.ts`, `lib/inventory-source.stub.ts`,
   `lib/errors.ts`, `app/api/commitments/route.ts`, `app/api/sync/route.ts`. Re-run attack 2's
   HTTP assertion and attack 4's 4.9/4.10. Commit.
7. **Design tokens + status logic.** `app/globals.css`, `lib/status.ts`,
   `lib/relative-time.ts`, `components/icons.tsx`, `status-badge`, `stale-badge`,
   `relative-time`. Commit.
8. **Inventory view.** `app/inventory/page.tsx`, `inventory-list`, `inventory-row`,
   `availability-block`, `search-field`, `filter-bar`, `loading.tsx`. Commit.
9. **PWA.** `app/manifest.ts`, `scripts/generate-icons.mjs`, `public/sw.js`, registration in
   `app/layout.tsx`. Commit.
10. **README + full harness re-run.** `README.md`, `verify/README.md`,
    `scripts/check-no-secrets.sh`. Run `run-all.mjs` and the secrets check. Commit.
11. **Baseline commit** so steps 2 and 3 can run as deltas against it (D8).

Steps 1–4 before any UI is the important ordering constraint. Everything else can flex.

---

## 8. Assumptions and decisions

### Stated assumptions carried from D4 — NOT gaps, do not escalate

| # | Question | Assumption |
|---|---|---|
| D4-1 | Where does inventory truth live today? | The admin-editing/override layer is a **permanent** layer, not interim scaffolding. Overrides are first-class, attributed and timestamped. |
| D4-2 | Sales Orders or Invoices, and when entered? | The QuickBooks baseline is **stale and incomplete**; source `committed` may be understated. The delta ledger compensates. |
| D4-3 | Multi-location? | Single location. Stub writes `location = 'default'`. Column exists; no UI. |
| D4-5 | Real product names? | Generic but realistic furniture catalogue, invented SKUs and names, no logos. |

Ships in `inventory_authority = 'quickbooks'` mode — show both numbers, never silently
override. None of these may be presented to anyone as established fact.

### Decisions made by Starter in this plan

| # | Decision | Rationale |
|---|---|---|
| **A1** | `signInWithOtp({ shouldCreateUser: false })`; users pre-provisioned by the Human | The default lets anyone on the internet self-register into a portal showing a client's inventory. The brief requires ~120 external users to sign in with just an email — pre-provisioning satisfies that and does not imply self-registration. **Flagged to Phineas** (§9). |
| **A2** | Login always responds identically whether or not the address exists | User-enumeration leak; with ~120 named external reps it is a real one. |
| **A3** | Seed timestamps emitted as `now() - interval 'N minutes'`, not literals | A file generated today and applied next week would show every row stale and make freshness undemonstrable. Keeps the file byte-stable and the data correctly aged. |
| **A4** | `available` is never clamped at zero | A negative figure means the source dropped on-hand below what is already spoken for. Clamping hides exactly the condition a rep needs to see. |
| **A5** | The status badge is computed from `qty_available` (the conservative figure) in **both** authority modes | Authority governs presentation emphasis, not safety. A badge reading "in stock" because QuickBooks had not caught up would reintroduce the oversell bug. |
| **A6** | Three fixtures added beyond the four the brief pins: `SEA-9005` (stale), `SEA-9006` (last-unit, available exactly 1), `SEA-9007` (delta baseline 40/10) | The stale threshold cannot be demonstrated without a stale row, and attacks 2 and 3 need deterministic SKUs with known starting quantities. Not scope expansion — each serves a stated requirement. |
| **A7** | Search/filter runs client-side over the full row set | ~96 rows / ~30KB. A round trip per keystroke on a phone with poor signal is worse than every alternative. Revisit above ~2,000 rows. |
| **A8** | No detail route; rows expand in place | Keeps the three-tap budget and avoids losing scroll position. |
| **A9** | Plain CSS + CSS Modules rather than Tailwind | The achromatic token set must be auditable in one place so `ui` reads tokens rather than hunting utility classes. |
| **A10** | Sync is manual (`POST /api/sync`) with no scheduled job | Nothing in the brief asks for a scheduler in step 1, and an unattended job is the most likely place a time-based retirement would later creep in. |

### Deferred to step 3 — noted, not decided here

- **Commitment cancellation.** The brief names exactly three lifecycle states and none of them
  represents "recorded in error." A rep who mis-keys a commitment currently has no way to undo
  it, and the trigger deliberately forbids editing `qty`. This is correct for step 1 (there is
  no UI to mis-key from) but step 3 must decide between a fourth state and an admin-only
  reversing entry. Raised here so it is designed rather than discovered.
- Who may match commitments to source documents, and through what interface.
- Whether `retired` is set by fulfilment (invoice) or by admin action.

---

## 9. Open questions

**None blocking.** Every client-dependent question is settled by D4 as a stated assumption,
and D1–D8 resolve the rest.

One item is flagged for Phineas's awareness rather than escalated, because the brief supports
the reading taken and reversing it is a one-line change:

- **A1 — user provisioning.** The plan assumes users are pre-provisioned by the Human in the
  Supabase dashboard (`shouldCreateUser: false`) rather than self-registering. The brief says
  ~120 external users must be able to sign in with just their email address; it does not say
  how they come to exist. If the Human intends open self-registration, `shouldCreateUser`
  flips to `true` and everything else stands. If Phineas wants that confirmed before Builder
  starts, say so; otherwise Builder proceeds on the assumption as written.

---

## 10. Hand-off notes for the retrospective

- **`Edit` was unavailable in this session**, so the plan could not be appended to
  incrementally and had to be composed as whole-file writes. That is why it is four documents
  rather than one: a single file large enough to hold all of it exceeded a single write. Worth
  Chris knowing, because the "append, never rewrite" revision rule in the Starter role
  definition assumes an edit capability that was not present here. Revisions to this plan
  should be added as a new dated document (e.g. `docs/REVISION-<date>.md`) referenced from
  this file's header table, rather than by rewriting these four.
- **The stale-baseline requirement had a genuine design ambiguity worth recording.** The brief
  specifies retirement by "matching" but does not define what a match is. Two readings were
  available — explicit document-reference matching, and quantity absorption — and they behave
  identically in single-rep tests while diverging badly the moment two reps commit the same
  SKU. The plan takes the explicit reading and says why. If the client later reports that
  QuickBooks Sales Orders carry no reference the portal can key on, this decision needs
  revisiting, and it will be cheaper to revisit having written down which reading was chosen.
- **The `security_invoker` view interaction with the commitments aggregate cost the most
  thought.** A `security_invoker` view is required to avoid an RLS bypass, but it makes reps
  compute a portal delta from only their *own* commitments — which produces an availability
  figure that is too high and silently reintroduces the oversell bug. The resolution (a
  `SECURITY DEFINER` aggregate function returning totals only) is in `SCHEMA.md` §8. This is
  the kind of thing that would have shipped wrong and passed every single-user test, and it is
  a good candidate for a standing rule.
- **The plan is smaller than the build it describes**, which is where it should be. If a step-2
  or step-3 revision starts pushing these documents toward transcript length, that is worth
  catching in the retrospective.

---

## Revision — 2026-08-19: the unclassified-error default, and what it costs

Appended, not merged. §8, §9 and §10 above stand as written and are not rewritten.

**One point in §10 is superseded, and only that one.** The note that `Edit` was unavailable, and
the consequence drawn from it — that revisions to this plan should go into a separate dated
document rather than be appended here — no longer applies. `Edit` is available and `docs/PLAN.md`
is in scope, so this revision is appended in place. Everything else in §10, including the reason
the plan is four documents rather than one, is unchanged and still accurate.

### The decision

Two directions were safe, and they point opposite ways.

- **A — chosen.** An auth error matching no known `status`/`code` branch classifies
  **UNAVAILABLE**. The caller is told the portal cannot send; the address is never mentioned.
- **B — rejected.** Default to **SUPPRESSED**, so an unseen code could never leak whether an
  address is registered.

Both are defensible. This is a genuine conflict between two safe directions, not a case of one
being an oversight, and it is recorded here for that reason.

### Why A

The failure B prevents is **total**. A wrong or rotated anon key makes the portal look healthy
while none of the ~120 reps can sign in, and the only evidence is a server-side log line nobody
is watching. That is the exact defect this whole strand of work exists to remove, and B
reintroduces the class of it: an unrecognised error would be answered with the success page.

The failure A risks is **narrow and conjunctive**. It requires a dependency bump that renames an
address-specific code out of `SUPPRESSED_CODES`, **and** an attacker probing addresses. What it
yields is whether one address is registered — real, but bounded, and it does not compound.

A total failure with no alarm on it outranks a narrow one that needs two independent things to
go wrong first. That is the trade, made explicitly.

### What A costs

The anti-enumeration property is **no longer guaranteed by the classifier alone**. It is
guaranteed by the classifier **plus assertion 5.4**. That is a real change in where the property
lives, and it must be written down rather than assumed, because a future reader looking only at
`app/login/auth-error.ts` would not be able to see it.

If a rename moves an address-specific code out of the suppressed set, the unregistered address is
answered `/login?error=unavailable` while the registered one is answered `/login/check-email`,
the two responses stop being indistinguishable, and 5.4 fails. **That is why 5.4 is blocking, not
advisory** — it is a `report.check`, a failed `check` records `FAIL`, a `FAIL` makes the suite's
report not `ok`, and the runner exits non-zero on it. There is no warning tier for it to land in.
It is also why the 5.4 comparison is now structurally incapable of reporting `NOT EXECUTED` once
both responses are in hand: the preconditions live in a function that is never given the report,
and the comparison is given a verdict-only view whose `notExecuted` throws. `NOT EXECUTED` and
`FAIL` mean opposite things, and this ruling depends on 5.4 being able to say the second one.

### Where the mitigation is not in force

5.4 is conditional on `PORTAL_BASE_URL`. When it degrades to `NOT EXECUTED` for a genuine
precondition, the mitigation **did not run for that run**, and the run says so rather than
implying otherwise. A run that could not execute 5.4 is not a run in which the anti-enumeration
property was demonstrated. Absence of evidence, printed as absence of evidence.

### The rate-limit asymmetry — CLOSED on 2026-08-19

This section used to record an open enumeration oracle. It is now closed, and the correction
matters more than the history.

With `shouldCreateUser: false` the email-send path is reached only for registered addresses, so
`over_email_send_rate_limit` fires only for a registered address. While that code classified
`RATE_LIMITED`, submitting the same address twice inside the per-address throttle window returned
`/login?error=rate_limited` for a registered address and `/login/check-email` for an unregistered
one — a reliable oracle against the ~120 named reps the anti-enumeration defence protects. A run
in which **only the registered address** was throttled was itself an instance of that signal.

Under the 2026-08-19 ruling — *a security predicate that branches on unmeasured vendor behaviour
must fail toward the safe classification until it is measured* — `over_email_send_rate_limit` was
moved into `SUPPRESSED_CODES` in `app/login/auth-error.ts`. Registered and unregistered responses
are now identical **inside** the throttle window as well as outside it. Consequently **5.4 no
longer degrades to `NOT EXECUTED` on a one-sided throttle for that code**: a throttled registered
address redirects to `/login/check-email`, byte-identical to the unregistered one, which is
exactly what 5.4c compares. `isRateLimitRedirect` remains, and still guards
`over_request_rate_limit` and a bare `429` — both IP/route-level, address-independent, and
legitimate re-run conditions.

The Human's sanction of "throttle fired → `NOT EXECUTED`" stands for the codes that still reach
`RATE_LIMITED`; it is simply no longer reachable via the per-address code. `RATE_LIMIT_CODES`
retains exactly one member, `over_request_rate_limit`, and the set is deliberately kept: the
`status === 429` branch and invariants 5.C2/5.C5 depend on it existing.

The cost of the move — suppressing a throttle re-hides a project-wide failure mode — is paid by
the server-side configuration health signal at `GET /api/health/auth`, not absorbed.

### A concrete case the default catches

`@supabase/auth-js` throws `AuthUnknownError` when the response body will not parse as JSON and
the status is not in its network-error list (`lib/fetch.js:49`), and `AuthUnknownError` carries
neither `status` nor `code` (`lib/errors.js:79-85`). So a gateway 401 delivered as an HTML edge
error page — precisely the invalid-anon-key shape the inference note in `app/login/auth-error.ts`
describes — does **not** reach the 401 branch. It falls to the default and lands
`unavailable:unclassified`, and the portal fails honestly anyway. Under B it would have shown the
success page. This is the branch `UNCLASSIFIED_AUTH_ERROR` exists to make findable: the call site
in `app/login/actions.ts` logs that marker on that reason alone, carrying `status`, `code` and
`name` and never the address, so the case can be grepped out of a production log instead of being
reconstructed from a redirect.
