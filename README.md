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
| `npm run verify` | **the four verification attacks, against a real local Postgres** |
| `npm run check:secrets` | repo-wide grep for key-shaped strings |

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

---

## Applying the database

**Migrations are written here and applied by hand.** Nothing in this build connects to,
authenticates against or runs anything on the hosted Supabase project. The Human pastes each
file into the SQL editor, in numeric order, so a person reads every schema change.

Paste these in order:

| # | File | Contents |
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

Then the seed:

| # | File | When |
|---|---|---|
| 13 | `supabase/seed/0001_seed_catalogue.sql` | any time after migration 12 |
| 14 | `supabase/seed/0002_seed_fixtures.sql` | after 0001 |
| 15 | `supabase/seed/0003_seed_demo_delta.sql` | **after at least one user has signed in** |

`0003` is safe to paste at any point — if no profile exists yet it raises a `NOTICE` and does
nothing, so re-paste it after the first sign-in.

If `CREATE TRIGGER on_auth_user_created` in migration 2 is refused (some projects do not permit
a trigger on `auth.users`), that is survivable: `ensure_profile()` is the documented fallback
and the auth callback calls it on every successful sign-in.

---

## Provisioning users

**Users are pre-provisioned. There is no self-registration.** `signInWithOtp` is called with
`shouldCreateUser: false`, so an address that has not been added cannot sign in. Left at the
default, anyone on the internet with any email address could self-register into a portal
showing a client's inventory.

To add a user:

1. Supabase dashboard → **Authentication → Users → Add user → Send invitation** (or
   *Create new user*), and enter their email address. No password is set — this project has
   none.
2. They sign in at `/login` by entering that address and following the emailed link.
3. A `profiles` row is created automatically with role `rep`.

To make someone an admin, in the SQL editor:

```sql
UPDATE public.profiles SET role = 'admin' WHERE email = 'their.address@example.com';
```

There is **no self-service path to `admin`** anywhere in the application, and no `role` value
is ever accepted from a request. Role is read from `public.profiles.role` in the database and
enforced by RLS.

The magic-link email template does not need changing. The callback handles both the default
`{{ .ConfirmationURL }}` (PKCE `code`) and `{{ .TokenHash }}` shapes.

---

## Verification

Four things here are most likely to be confidently wrong, and all four fail *silently*.
They are actively attacked against a real database — **not mocked**:

```bash
npm run verify
```

1. **RLS bypass** — as a `rep`, read another user's commitments and rows the policy forbids,
   then write to inventory, all by querying directly rather than through the UI.
2. **Concurrent commitment on the last unit** — two sessions commit the final unit at the same
   moment. Exactly one succeeds.
3. **Delta survives a stale baseline** — a commitment keeps reducing `available` through a
   source sync that does not mention it, and through 30 simulated days.
4. **Role enforcement is server-side** — every admin-only action refused for a `rep` when
   invoked directly.

`verify/README.md` documents the method for each, what a pass looks like, how the harness gets
a database, and — explicitly — **which assertions are skipped and why**. A skipped assertion
prints as SKIP and is never reported as a pass.

---

## How it is put together

```
app/            routes. /login, /auth/callback, /inventory, and two API routes
components/     the inventory list, row, badges, filters — plus their CSS modules
lib/            supabase clients, auth, the adapter, status derivation, error mapping
supabase/       migrations (written, applied by hand) and generated seed
scripts/        deterministic seed and icon generators, secrets check
verify/         the four attacks
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
