# Inventory Portal

A mobile-first, authenticated sales portal. Reps sign in with a magic link and see a
searchable, filterable inventory list showing **on hand**, **committed**, **available**,
**incoming**, source attribution and freshness.

**The number a rep acts on is `available`, not `on hand`.** Showing on-hand alone is what
causes selling stock that is already spoken for — the bug this project exists to prevent.

QuickBooks is not accessible yet. It is stubbed behind a single adapter module so the only
thing that changes at cutover is *who writes the inventory rows*.

---

## What this build is, and is not

This is **build-order step 1**: auth + inventory view + seed data. It stands alone as a
demoable artifact — sign in, see the list, search and filter it.

**Not in this build.** Their absence is deliberate and is not a defect:

| | Status |
|---|---|
| Rep commitment-recording screen (step 2) | approved in principle, held |
| Admin inventory editing, overrides, reconciliation view (step 3) | approved in principle, held |
| Promotions, document library, notification centre | approved in principle, later |
| Real Web Push (service worker push, VAPID, permission prompt) | out of scope |
| QuickBooks / Rightworks / Conductor integration | no client access yet — stubbed |
| Order entry / write-back to QuickBooks | deliberately later |
| Multi-location UI | the `location` column exists; no UI |

There are no "coming soon" placeholders anywhere. If a user cannot do it here, the interface
does not mention it.

**One deliberate carve-out.** The commitments **data layer** ships in full — the table, the
`pending → confirmed_in_source → retired` lifecycle, its trigger, its RLS, the
concurrency-controlled `record_commitment` function and `apply_inventory_sync`. Its **UI does
not**. The operation is reachable server-side only, which is how the two ledger-related
verification requirements are attacked. The inventory view *does* display `committed` and the
show-both-numbers presentation, because that is step 1's centrepiece.

---

## Stack

- **Next.js 15 (App Router)** + **TypeScript** (strict)
- **Supabase** — Postgres + Auth, via `@supabase/supabase-js` and `@supabase/ssr`
- **Magic-link passwordless auth.** No password fields, no reset flow, no credential storage.
- **Netlify** hosting; deploys on push to `main`
- **PWA** — installable via "Add to Home Screen"
- **Plain CSS + CSS Modules.** No Tailwind, no CSS-in-JS. The achromatic token set lives in
  one auditable place (`app/globals.css`).

---

## Running it locally

```bash
npm install
cp .env.example .env.local     # then fill in the values (see below)
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the service-role import restriction |
| `npm run seed:generate` | regenerates `supabase/seed/0001` and `0002` (deterministic) |
| `npm run icons:generate` | regenerates the PWA icons (deterministic) |
| `npm run verify:preflight` | read-only check of what the hosted project is missing. Creates nothing |
| `npm run verify:identities` | creates the two test identities on the hosted project |
| `npm run verify` | **the four verification attacks, against the configured hosted project** |
| `npm run verify:identities:remove` | removes every artefact the harness created |
| `npm run verify:local` | the four attacks against an ephemeral local Postgres — **policy logic only** |
| `npm run check:secrets` | repo-wide grep for key-shaped strings |

`npm run verify` targets the hosted project and **never falls back to a local database**.
`npm run verify:local` is the only way to the embedded-Postgres path, and it is not a
substitute: it does not cover identity issuance, JWT signing, JWT verification, PostgREST or
session handling.

### Environment variables

`.env.example` carries variable **names with empty values** and nothing else. Real values come
from the Supabase dashboard (Project Settings → API) and go in `.env.local`, which is
gitignored, and in the Netlify dashboard for the deployed site.

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

**`SUPABASE_SERVICE_ROLE_KEY` must never reach the browser.** It is never prefixed
`NEXT_PUBLIC_`, is read in exactly one file (`lib/supabase/admin.ts`, which begins
`import 'server-only'`), and an ESLint `no-restricted-imports` rule limits importers to
`app/api/**` and `lib/inventory-source.stub.ts`. The frontend uses the anon key only.

**No secrets are ever committed.** There are none anywhere in this repo, including in the seed
data — not even plausible-looking placeholders. Magic-link auth means there are no passwords
to placeholder in the first place.

**One more name, and it is deliberately not in `.env.example`.** `PORTAL_BASE_URL` tells the
verification harness where a running copy of this app is, so it can exercise the three HTTP
assertions. **The application never reads it.** `.env.example` is copied to `.env.local` and
consumed by Next.js, and listing a name there that the app does not read would say the app
needs a variable it never looks at. Pass it on the command line for the one run that uses it:

```bash
PORTAL_BASE_URL=http://127.0.0.1:3000 npm run verify
```

Without it those three assertions print `NOT EXECUTED` and say why. They are never counted as
passes and never silently omitted.

---

## Running this against the hosted Supabase project

Nothing in this repository has ever been applied to the hosted project. Everything below is
manual and in this order. Deviating from the order produces a demo without its centrepiece —
see step 7.

**Project ref:** `rakslwwxduovcqnuercz`.

### Step 1 — apply the 12 migrations

Supabase dashboard → **SQL Editor**. Paste each file's full contents and run it, in this
order. Do not skip, do not reorder, do not batch.

| # | File | What it creates |
|---|---|---|
| 1 | `supabase/migrations/0001_extensions_and_enums.sql` | 4 enum types |
| 2 | `supabase/migrations/0002_profiles_and_role_helpers.sql` | `profiles` + RLS + `app_role()`, `is_admin()`, `handle_new_user()` + trigger, `ensure_profile()` |
| 3 | `supabase/migrations/0003_products.sql` | `products` + RLS + indexes |
| 4 | `supabase/migrations/0004_inventory.sql` | `inventory` + generated `qty_available_source` + RLS + indexes |
| 5 | `supabase/migrations/0005_commitments.sql` | `commitments` + RLS + lifecycle trigger |
| 6 | `supabase/migrations/0006_app_settings.sql` | `app_settings` singleton + RLS + the single row |
| 7 | `supabase/migrations/0007_inventory_sync_runs.sql` | `inventory_sync_runs` + RLS |
| 8 | `supabase/migrations/0008_inventory_view.sql` | `pending_commitment_totals()` + `v_inventory` |
| 9 | `supabase/migrations/0009_fn_record_commitment.sql` | the concurrency-controlled write path |
| 10 | `supabase/migrations/0010_fn_apply_inventory_sync.sql` | match-only retirement |
| 11 | `supabase/migrations/0011_rls_policies.sql` | all 15 policies across 6 tables |
| 12 | `supabase/migrations/0012_grants.sql` | revokes, grants, function EXECUTE grants |

If `CREATE TRIGGER on_auth_user_created` in migration 2 is refused — some projects do not
permit a trigger on `auth.users` — that is survivable. `ensure_profile()` is the documented
fallback and the auth callback calls it on every successful sign-in. Note that you hit this,
because it changes nothing you have to do but it is worth knowing.

### Step 2 — apply the two seed files

| # | File |
|---|---|
| 13 | `supabase/seed/0001_seed_catalogue.sql` |
| 14 | `supabase/seed/0002_seed_fixtures.sql` |

**Do not apply `0003` yet.** It is step 7.

### Step 3 — set the environment variables

Values come from the Supabase dashboard → **Project Settings → API**. They are never
committed.

| Variable | Where it goes | What it is |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` locally; **Netlify dashboard** for the deployed site | the project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` locally; **Netlify dashboard** for the deployed site | the anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` locally; **Netlify dashboard** for the deployed site | the service-role / secret key |

`cp .env.example .env.local` gives you the three names with empty values. Fill them in there.

**`SUPABASE_SERVICE_ROLE_KEY` is server-side only.** Never prefix it `NEXT_PUBLIC_`. It is
read in exactly one application file (`lib/supabase/admin.ts`, which begins
`import 'server-only'`) and in the verification tooling. It is never logged, never echoed,
never committed, and never sent to a browser.

`.env.local` is gitignored. `npm run check:secrets` fails if a dotenv file is ever present in
the working tree — so run it from a clean checkout, or move your `.env.local` aside first.

`PORTAL_BASE_URL` is a **harness-only** input, deliberately absent from `.env.example` because
the application never reads it. Pass it on the command line in step 10.

### Step 4 — provision the real people

**Users are pre-provisioned. There is no self-registration.** `signInWithOtp` is called with
`shouldCreateUser: false`, so an address that has not been added cannot sign in — left at the
default, anyone on the internet could self-register into a portal showing the client's
inventory.

> **Someone must provision Levon before the demo, or he cannot sign in.** This is not optional
> and there is no fallback path. Adding him takes about thirty seconds and cannot be done
> during the demo without an admin in the Supabase dashboard.

For each person: dashboard → **Authentication → Users → Add user** → enter their email
address. No password is set; this project has none.

To make someone an admin, in the SQL editor:

```sql
UPDATE public.profiles SET role = 'admin' WHERE email = 'their.address@example.com';
```

There is no self-service path to `admin` anywhere in the application, and no `role` value is
ever accepted from a request.

### Step 5 — the real rep signs in

They go to `/login`, enter their address, and follow the emailed link. This creates their
`profiles` row with role `rep`.

This must happen **before** step 7. `supabase/seed/0003_seed_demo_delta.sql` binds the demo
delta to the earliest `rep` profile by `created_at`; if no rep profile exists it raises a
`NOTICE` and does nothing.

The magic-link email template does not need changing. The callback handles both the default
`{{ .ConfirmationURL }}` (PKCE `code`) and `{{ .TokenHash }}` shapes.

### Step 6 — confirm the sign-in worked

```sql
SELECT id, email, role, created_at FROM public.profiles ORDER BY created_at;
```

You should see the real rep with role `rep`. If the table is empty, the profile trigger did
not fire — sign in once more; the auth callback calls `ensure_profile()` on every successful
sign-in.

### Step 7 — apply the demo delta

| # | File |
|---|---|
| 15 | `supabase/seed/0003_seed_demo_delta.sql` |

**Order matters here and the failure is silent.** This file:

- binds to the **earliest `rep` profile by `created_at`**, and
- **does nothing at all if any commitment row already exists, anywhere.** Its guard is
  `IF EXISTS (SELECT 1 FROM public.commitments)` — not scoped by sku or by location.

So it must be applied after a real rep has signed in and **before** anything else writes a
commitment, including the verification harness. Run it now and confirm:

```sql
SELECT sku, location, qty, state, note FROM public.commitments;
```

You should see one row: `SEA-9007 / default / 6 / pending / Demo delta: …`. That row is what
makes the brief's worked example — 40 on hand, 10 committed in QuickBooks, 6 more committed by
reps, 24 available — demoable. If it is missing, do not continue; `0003` will never produce it
once other commitments exist.

### Step 8 — check what the harness can see

```bash
npm install
npm run verify:preflight
```

Read-only. Creates nothing. It tells you which migrations or seed files are missing, whether
the demo delta is in place, and whether the test identities exist. It distinguishes
`NOT EXECUTED — no Supabase configuration` from `NOT EXECUTED — schema not applied` from
`NOT EXECUTED — seed not applied`, because those send you to three different places. Fix
anything it reports before continuing.

### Step 9 — create the test identities

```bash
npm run verify:identities
```

Uses the service-role Admin API to create `rep.verify@example.invalid` and
`admin.verify@example.invalid`, set their `profiles.role`, and mint real sessions **without
sending any email and without setting any password**. Idempotent — safe to re-run.
`example.invalid` is a reserved, non-routable TLD: those addresses cannot receive mail and
cannot be mistaken for a person's.

**It will refuse to run if the demo delta is not yet in place** (step 7). That refusal is
correct: creating test identities first risks binding the demo delta to an artefact that gets
deleted afterwards, and the first commitment the harness writes would suppress `0003`
permanently. If you see the refusal, go back to step 7.

### Step 10 — run the four attacks

```bash
npm run verify
```

To include the three HTTP assertions (`2a.10`, `4.9`, `4.10`), start the app in a second
terminal first and point the harness at it:

```bash
npm run dev                                            # terminal 1
PORTAL_BASE_URL=http://127.0.0.1:3000 npm run verify   # terminal 2
```

`PORTAL_BASE_URL` is a harness input only — the application never reads it, which is why it is
not in `.env.example`. Without it, those three assertions print `NOT EXECUTED` and say so. The
harness mints the session cookie itself; there is no cookie for you to paste anywhere, by
design — a pasted cookie is a credential in your shell history.

**Expected output.** A banner naming the project ref and a booleans-only configuration block
(`set` / `unset`, never a value or any fragment, length or hash of one). Then a read-only
preflight. Then, per attack, the method, each assertion with `PASS` / `FAIL` / `STATIC` /
`NOT EXECUTED`, and a per-attack result line. Then a summary listing every `NOT EXECUTED`
assertion with its reason, and every `STATIC` assertion with the note that it asserts
migration source rather than deployed state.

Exit code is 0 only if nothing failed. **A `NOT EXECUTED` is never counted as a pass.** If
configuration is missing or the endpoint is unreachable, every affected attack prints
`NOT EXECUTED — no Supabase configuration` and the command exits non-zero — it never silently
falls back to a local database.

**This writes to the live project.** It creates products prefixed `KYV-`, inventory and
commitment rows at `location = 'kyv-verify'`, and `inventory_sync_runs` rows. While they
exist they are **visible in the app's inventory list** under the category
"KYV verification artefact". It does **not** modify any `SEA-*` seed row or the demo delta,
and it writes `app_settings` only back to its own current value. Step 11 removes all of it.

### Step 11 — remove the verification artefacts

```bash
npm run verify:identities:remove
```

Deletes everything steps 9 and 10 created, in the order the foreign keys require, and prints
what it deleted. If it cannot run, the equivalent by hand in the SQL editor — **this order, or
`ON DELETE RESTRICT` blocks you, and deleting the users first NULLs `run_by` and makes the
sync-run rows unidentifiable**:

```sql
DELETE FROM public.commitments WHERE location IN ('kyv-verify', 'kyv-verify-2');

DELETE FROM public.commitments WHERE rep_id IN (
  SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id
   WHERE u.email IN ('rep.verify@example.invalid', 'admin.verify@example.invalid'));

-- inventory_sync_runs.run_by REFERENCES profiles (id) ON DELETE SET NULL, so this MUST run
-- before the users are deleted or run_by becomes NULL and these rows can no longer be found.
DELETE FROM public.inventory_sync_runs WHERE run_by IN (
  SELECT u.id FROM auth.users u
   WHERE u.email IN ('rep.verify@example.invalid', 'admin.verify@example.invalid'));

DELETE FROM public.products WHERE sku LIKE 'KYV-%';   -- cascades public.inventory
```

Then dashboard → **Authentication → Users** → delete `rep.verify@example.invalid` and
`admin.verify@example.invalid`. That cascades their `profiles` rows.

Confirm nothing is left:

```sql
SELECT count(*) FROM public.products    WHERE sku LIKE 'KYV-%';        -- 0
SELECT count(*) FROM public.commitments WHERE location LIKE 'kyv-%';   -- 0
SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id = p.id
 WHERE u.email LIKE '%.verify@example.invalid';                        -- 0
SELECT sku, qty, state FROM public.commitments;                        -- the demo delta, alone
```

---

## Verifying policy logic without the hosted project

```bash
npm run verify:local
```

Stands up an ephemeral local PostgreSQL server, applies the committed migrations to it, and
runs the same four attacks — including the deterministic lock-interleaving proof that the
hosted path cannot reach, because PostgREST has no open transactions.

**It exercises policy logic only.** It does not cover identity issuance, JWT signing, JWT
verification, PostgREST, or session handling. A pass here is never a claim about the hosted
project. It needs none of the three environment variables and touches nothing remote.

`verify/README.md` documents the method for each attack, and — explicitly — which assertions
run live against the hosted project, which are labelled `STATIC` source checks, and which are
`NOT EXECUTED` and why.

---

## How it is put together

```
app/            routes. /login, /auth/callback, /inventory, and two API routes
components/     the inventory list, row, badges, filters — plus their CSS modules
lib/            supabase clients, auth, the adapter, status derivation, error mapping
supabase/       migrations (written, applied by hand) and generated seed
scripts/        deterministic seed and icon generators, secrets check, test identities
verify/         the four attacks. verify/hosted/ targets the hosted project over HTTPS;
                verify/lib/harness.mjs is the demoted local-only path (loopback guarded)
docs/           the implementation plan this was built from
```

A few decisions worth knowing before changing anything:

- **`commitments` has a SELECT policy and no INSERT/UPDATE/DELETE policy, for any role,
  including admin.** This is deliberate. An INSERT policy would let a client write a row
  directly and skip the availability check inside `record_commitment`, making the concurrency
  control trivially bypassable. Every write goes through that function.
- **`v_inventory` is created `WITH (security_invoker = on)`.** A Postgres view runs as its
  owner by default, which would make it a complete RLS bypass reachable with the anon key.
- **The portal delta comes from `pending_commitment_totals()`, a `SECURITY DEFINER`
  aggregate** — not from selecting `commitments` in the view. With `security_invoker` on, a
  rep would otherwise compute the delta from only their *own* commitments and see an
  availability figure that is too high, silently reintroducing the oversell bug. The function
  returns totals per `(sku, location)` and nothing else: reps learn how many units are spoken
  for, never by whom.
- **`record_commitment` takes no `rep_id` parameter.** Identity comes from `auth.uid()` inside
  the function. That is what stops a `SECURITY DEFINER` function from becoming an RLS bypass.
- **`app_role()` / `is_admin()` are `SECURITY DEFINER`.** They are called from inside the
  policies on `profiles` itself; a `SECURITY INVOKER` function would recurse (`42P17`).
- **`FORCE ROW LEVEL SECURITY` is deliberately not used.** The `SECURITY DEFINER` write path
  depends on the table-owner bypass.
- **Retirement is by matching only. Nothing time-based.** There is no `now()`, `interval` or
  `age()` anywhere in the retirement path, and the lifecycle trigger rejects
  `pending → retired` outright, so no future cron job can retire a live delta in one step. A
  commitment a sync does not mention persists in `pending` and keeps reducing `available`,
  indefinitely. **That is the default, not a special case.**
- **`available` is never clamped at zero.** A negative figure means the source dropped on-hand
  below what is already spoken for — exactly the condition a rep needs to see.

### The QuickBooks stub

`lib/inventory-source.ts` is the only module that knows where inventory rows come from. At
cutover it returns a Conductor-backed implementation and nothing else in the repo changes.
Three rules make that true:

1. **Store the components** (`qty_on_hand`, `qty_committed`, `qty_incoming`), derive
   `available`. Never a single blended quantity.
2. **The `location` dimension exists from day one.** The stub writes `location = 'default'`.
3. **One adapter module, one function signature.**

`source` and `source_payload jsonb` are on the inventory table and `source` is surfaced on
every card — a rep seeing whether a number came from QuickBooks or from a person is a trust
feature, and it makes the cutover observable rather than silent. The stub writes
`quickbooks_stub`, labelled "QuickBooks (stub)"; it never claims to be the real integration.

**Stated honestly: this contract is a guess.** The client's QuickBooks edition, whether they
use Advanced Inventory, and whether Sales Orders are entered at all are all unknown. The three
rules are what make a wrong guess cheap instead of expensive. Nobody should be told
integration is "just a config change" until those questions are answered.

### Authority mode — a setting, not a fork

`app_settings.inventory_authority` is `'quickbooks'` (shipping default) or `'portal'`.

```
quickbooks:  AVAILABLE (QUICKBOOKS)  30
             40 on hand · 10 committed in QuickBooks
             ⚑ 6 more committed by reps, not yet in QuickBooks → 24 available

portal:      AVAILABLE  24
             40 on hand · 16 committed (10 QuickBooks + 6 rep)
             QuickBooks alone shows 30 available
```

**Neither mode hides a number and neither silently overrides.** Both figures are on screen in
both modes; only the emphasis moves. Both modes read the same view, compute the same figures
and render the same component — the mode is consulted in exactly one function
(`availabilityPresentation` in `lib/status.ts`), which returns data, so there is no second
rendering branch to keep in sync. Flipping it is a one-row `UPDATE` by an admin; no deploy.

**The status badge is computed from the conservative `qty_available` in both modes.** Authority
governs emphasis, not safety. A badge reading "in stock" because QuickBooks had not caught up
would reintroduce the bug the project exists to prevent.

### Stock status is legible without reading the numbers

The palette is **achromatic — white, grays and black only**. No brand hue, no accent colour,
no logo, no company name. That makes "not by colour alone" binding rather than optional, and
with an achromatic palette status also cannot be carried by **lightness** alone: a status that
reads only as "the darker one" fails the requirement the same way a red/green pair would.

Every pair of statuses therefore differs on at least three channels:

| Status | Glyph | Border | Fill | Left rule | Label |
|---|---|---|---|---|---|
| In stock | filled square | solid | solid black | solid, full height | `IN STOCK` |
| Low | outlined triangle | solid | white | solid, top half | `LOW` |
| None — incoming | down-arrow in a dashed ring | dashed | white | dashed, full height | `NONE — INCOMING · ETA …` |
| None available | circle with a slash | dotted | hatched | dotted, full height | `NONE AVAILABLE` |

**Labels are always rendered — never icon-only, at any breakpoint.** Glyphs are `aria-hidden`;
the label carries the accessible name.

**Freshness is a separate, orthogonal badge**, because an item can be Low *and* Stale and
collapsing those onto one scale would hide one of them. Anything older than
`app_settings.stale_after_minutes` (default 360 — six hours, read from the database, not
hard-coded) gets a clock badge, an inverted fill, a dashed outline around the whole card, and
the label `STALE · updated 3 days ago`.

**No decorative animation.** No CSS transitions or keyframes at all. Press feedback is an
instantaneous `:active` border-width change; the loading skeleton is static.

### Seed data

`scripts/generate-seed.mjs` is a deterministic generator (mulberry32, fixed seed) — the rows
are not hand-authored. Both the script and its output are committed, so the data is
reproducible *and* reviewable in a diff. Re-running produces byte-identical files.

90 generated SKUs across 6 categories, plus 7 **pinned** fixtures that are emitted on every run
rather than depending on a random draw:

| SKU | Why it exists |
|---|---|
| `SEA-9001` | `available` at zero but stock incoming |
| `SEA-9002` | `on_hand` and `available` differ sharply — 14 available from an on-hand of 200 |
| `SEA-9003` | an admin override that **contradicts** the source number, attributed and timestamped |
| `SEA-9004` | a 124-character product name that threatens a mobile layout |
| `SEA-9005` | a stale row, so the freshness threshold is demonstrable |
| `SEA-9006` | availability of exactly 1 — the contended row in the concurrency attack |
| `SEA-9007` | 40 on hand / 10 committed — the brief's worked example for the delta ledger |

Seed rows carry **relative** timestamps (`now() - interval '17 minutes'`), so the file is
byte-stable yet the data is correctly aged whenever it is applied. A file generated today and
applied next week would otherwise show every row as days stale.

---

## Deployment

Netlify connects to this repository and deploys on **push to `main`**. Environment variables
are set in the Netlify dashboard, never in the repo.

**Pushing is a Human action** — a push is a deploy to real users. This repository has no
remote configured.
