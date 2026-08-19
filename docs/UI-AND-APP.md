# APPLICATION LAYER — Ascension Sales Portal (step 1)

Companion to `PLAN.md`. Auth flow, the QuickBooks adapter, authority modes, the inventory
view, the achromatic status encoding, and the seed generator.

Schema is in `SCHEMA.md`; policies and functions in `FUNCTIONS-AND-POLICIES.md`.

---

## 1. Auth flow — magic link, `@supabase/ssr`

No password fields. No password reset. No credential storage. If Builder finds itself writing
a `password` input, something has gone wrong.

### 1.1 Request

`app/login/page.tsx` — a single email field (56px tall, `type="email"`,
`inputMode="email"`, `autoComplete="email"`, `autoCapitalize="off"`) and one submit button
(min 48px tall, full width). Nothing else on the page. No sign-up link, no "forgot password",
no social buttons.

`app/login/actions.ts` (server action):

```ts
await supabase.auth.signInWithOtp({
  email,
  options: {
    emailRedirectTo: `${origin}/auth/callback`,
    shouldCreateUser: false,      // see below
  },
})
```

**`shouldCreateUser: false` is deliberate.** Users are pre-provisioned by the Human in the
Supabase dashboard. Left at the default, anyone on the internet with any email address could
self-register into a portal showing a client's inventory. This is recorded as assumption A1
in `PLAN.md` — the brief says ~120 external users must be able to sign in with just their
email, which pre-provisioning satisfies, and it does not say they self-register.

**The response is always the same**, whether or not the address exists:
redirect to `/login/check-email`, which reads *"If that address is registered, a sign-in link
is on its way. The link works once and expires in an hour."* Never reveal whether an account
exists — that is a user-enumeration leak, and with ~120 named external reps it is a real one.
This means the server action must not surface a `User not found` error to the client;
it logs server-side and returns the same success shape.

Rate limiting is Supabase's built-in per-address throttle. Nothing hand-rolled.

### 1.2 Callback — `app/auth/callback/route.ts`

**Handle both shapes.** Which one arrives depends on the Supabase email template, and getting
this wrong produces a link that appears to do nothing:

```ts
const code       = searchParams.get('code')        // PKCE flow (@supabase/ssr default)
const tokenHash  = searchParams.get('token_hash')  // templates using {{ .TokenHash }}
const type       = searchParams.get('type')        // 'magiclink' | 'email'

if (code)            await supabase.auth.exchangeCodeForSession(code)
else if (tokenHash)  await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
else                 redirect('/auth/auth-code-error')
```

On success: call `ensure_profile()` once (the trigger fallback, `SCHEMA.md` §2 — idempotent,
cheap, and it means a failed trigger on the hosted project does not produce a signed-in user
with no profile), then redirect.

**Open-redirect guard.** A `next` parameter is honoured only if it starts with `/` and does
not start with `//` or `/\`. Anything else falls back to `/inventory`. Do not skip this: an
open redirect on an auth callback is a phishing primitive.

On failure: `/auth/auth-code-error`, which says the link has expired or already been used and
offers a link back to `/login`. No error codes shown to the user.

**A note for the hand-off:** if the Human's Supabase email template still uses the default
`{{ .ConfirmationURL }}`, the `code` branch handles it. Switching the template to
`{{ .TokenHash }}` is a dashboard change and is **not** required for this build to work. Flag
it as informational, not as a blocking task.

### 1.3 Session — cookie handling, precisely

Three clients, three jobs. Getting these confused is the most common `@supabase/ssr` bug.

**`lib/supabase/client.ts`** — browser. `createBrowserClient(url, anonKey)`. Anon key only.

**`lib/supabase/server.ts`** — RSC / server actions / route handlers.
`createServerClient` with `cookies()` from `next/headers`, implementing `getAll`/`setAll`.
**`setAll` must be wrapped in try/catch** — a Server Component cannot set cookies and will
throw; the catch is safe precisely because middleware is refreshing the session on every
request.

**`lib/supabase/middleware.ts`** — the `updateSession(request)` helper. Four rules, all of
which cause silent, intermittent sign-outs when broken:

1. Use **`supabase.auth.getUser()`**, never `getSession()`. `getUser()` revalidates the token
   with the auth server; `getSession()` trusts whatever is in the cookie. In middleware,
   trusting the cookie is the vulnerability.
2. Put **no code between `createServerClient(...)` and `await supabase.auth.getUser()`**.
3. When constructing a redirect response, **copy the cookies from `supabaseResponse` onto
   it** — `newResponse.cookies.setAll(supabaseResponse.cookies.getAll())` — or return
   `supabaseResponse` itself. Returning a bare `NextResponse.next()` drops the refreshed
   tokens and the user is signed out a few minutes later, seemingly at random.
4. `setAll` writes to **both** `request.cookies` and the response.

**`lib/supabase/admin.ts`** — `createClient(url, serviceRoleKey, { auth: { persistSession: false } })`.
Starts with `import 'server-only'`. Importable only from `app/api/**` and
`lib/inventory-source.stub.ts`, enforced by the `.eslintrc.json` `no-restricted-imports`
rule. **Never used to render a page.** `app/inventory/page.tsx` uses the cookie-bound anon
client so the page itself is subject to RLS — meaning a policy bug shows up as missing data,
not as a silent leak.

### 1.4 Route protection

`middleware.ts` matcher:

```
'/((?!_next/static|_next/image|favicon.ico|icon-.*\\.png|apple-touch-icon\\.png|manifest\\.webmanifest|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
```

Middleware refreshes the session, then: unauthenticated request for anything other than
`/login`, `/login/check-email`, `/auth/callback`, `/auth/auth-code-error` → redirect to
`/login`. Authenticated request for `/login` → redirect to `/inventory`.

**Middleware is convenience, not access control.** It runs before the request reaches a route
and is exactly the kind of thing that gets bypassed by a direct API call. The real gate is
the database (`FUNCTIONS-AND-POLICIES.md` §3). In addition, `lib/auth.ts` provides:

- `getUser()` — `supabase.auth.getUser()` on the server client
- `getProfile()` — id/email/role from `profiles`
- `requireUser()` — redirects to `/login` if absent
- `requireAdmin()` — throws `KY003`/403 if `role !== 'admin'`; used by `app/api/sync/route.ts`

`app/inventory/page.tsx` calls `requireUser()` itself rather than relying on middleware.

### 1.5 Sign out

`app/signout/route.ts`, **POST only** (a GET sign-out is CSRF-able and gets triggered by link
prefetchers). Calls `supabase.auth.signOut()`, clears cookies, redirects to `/login`.

---

## 2. The QuickBooks adapter — `lib/inventory-source.ts`

One module, one function signature. Nothing else in the app knows which source is in use.

```ts
export type InventoryRow = {
  sku: string
  location: string
  qty_on_hand: number
  qty_committed: number
  qty_incoming: number
  incoming_eta: string | null            // ISO date
  source: 'quickbooks' | 'quickbooks_stub' | 'manual_override'
  source_payload: Record<string, unknown> | null
}

export interface InventorySource {
  fetchInventory(): Promise<InventoryRow[]>
}

export function getInventorySource(): InventorySource
```

`getInventorySource()` returns the stub today. At cutover it returns a Conductor-backed
implementation and **nothing else in the repo changes** — not the schema, not the view, not a
component, not a query. That is the contract, and it is the reason for the three stub rules.

`lib/inventory-source.stub.ts` reads the current source-of-record rows via the service-role
client and returns them unchanged. It is deliberately boring: it stands in for "QuickBooks
said the same thing again," which is precisely the stale-baseline condition attack 3 needs.
It does **not** invent drift, jitter, or random movement — a stub that changes numbers by
itself makes every test non-deterministic.

`app/api/sync/route.ts` is the only caller: `requireAdmin()` → `getInventorySource().fetchInventory()`
→ `apply_inventory_sync({ rows, matches: [] })`. There is no scheduled job in this run.

---

## 3. `inventory_authority` — one code path, two modes

**Both modes read the same view, compute the same five figures, and render the same
component.** The setting changes which figure is typographically primary and how the
secondary line is worded. There is no branch in the data layer, no second query, no alternate
component, and no `if (mode === 'portal')` anywhere outside `availability-block.tsx`.

Read once per request in `app/inventory/page.tsx` via `lib/settings.ts`, passed down as a
prop. Flipping the flag is a one-row `UPDATE` by an admin; no deploy.

### `quickbooks` mode — shipping default (D4)

```
AVAILABLE (QuickBooks)          30          ← qty_available_source, 28px/700
40 on hand · 10 committed in QuickBooks     ← components line, 14px
⚑ 6 more committed by reps, not yet in QuickBooks → 24 available   ← advisory, only when delta > 0
Source: QuickBooks (stub) · updated 4 minutes ago
```

### `portal` mode

```
AVAILABLE                       24          ← qty_available, 28px/700
40 on hand · 16 committed (10 QuickBooks + 6 rep)
QuickBooks alone shows 30 available          ← the source figure stays visible
Source: QuickBooks (stub) · updated 4 minutes ago
```

**Neither mode hides a number. Neither mode silently overrides.** In both, both figures are on
screen; only the emphasis moves. That is what "a setting, not a fork" means concretely.

**The status badge is computed from `qty_available` (the conservative figure) in both modes** —
see decision A5 in `PLAN.md`. Authority governs emphasis, not safety.

The advisory line renders only when `qty_committed_portal > 0`. With no commitments recorded
yet — the state a fresh demo starts in — every row shows the plain QuickBooks picture, which
is correct and not a bug.

---

## 4. The inventory view

Route: `/inventory`. It is the app. There is no other authenticated screen in step 1.

### 4.1 Data flow

`app/inventory/page.tsx` (RSC): `requireUser()` → `getSettings()` → `SELECT * FROM v_inventory
ORDER BY name` via the cookie-bound anon client → pass rows, settings and a server `now` into
`<InventoryList>` (client component).

**Fetch all rows, filter on the client.** The catalogue is ~96 rows / ~30KB of JSON. A round
trip per keystroke on a phone with poor signal is worse than every alternative, and it makes
search feel broken in exactly the conditions this app is used in. Revisit above ~2,000 rows.

### 4.2 Search and filter

- **Search field** — sticky at the top, 56px tall, `type="search"`. Matches `sku` OR `name`,
  case-insensitive substring. No debounce needed on an in-memory array. A clear (✕) button at
  48×48.
- **Category chips** — horizontally scrollable row, 44px tall, 12px gaps. Single-select plus
  an "All" chip. Selected state is encoded by **inverted fill + a 2px inset border + the
  chip's label prefixed with a check glyph** — three channels, not colour.
- **Status chips** — same treatment: All / In stock / Low / None available / Stale.
- **Sort** — a 3-option control: Name A→Z (default), Least available first, Recently updated.
- **Result count** — "18 of 96 products" under the filter bar, so an over-narrow filter is
  never mistaken for an empty catalogue.
- **Empty state** — "No products match ‘xyz’." plus a 48px "Clear filters" button.

Selections live in React state only. No URL params in step 1 (nothing to deep-link to yet).

### 4.3 Three-tap budget

Installed PWA launches to `/inventory` with a live session:

- Tap 1: category chip (or the search field) → Tap 2: the product row → expands **in place**
  to show components, source, override note and ETA.
- There is **no detail route**. Expansion is an in-place accordion, so no navigation, no back
  button, no lost scroll position.

### 4.4 Mobile layout

Designed at 375×667 first, widening upward. Never a desktop table that shrinks.

- One card per product, full width, `min-height: 88px`, 16px padding, 8px gap between cards.
- Card grid: product name (2-line clamp) and SKU on the left; the availability block on the
  right, right-aligned, never wrapping under the name.
- Sticky header (search + chips) with `position: sticky; top: 0`, opaque background.
- `padding-bottom: env(safe-area-inset-bottom)` on the list container; `viewport-fit=cover`.
- Tap targets: minimum **48×48 CSS px** everywhere. Chips 44px tall (their generous horizontal
  padding carries the target area). Rows are tappable across their full width.
- Type scale: base 17px; product name 18px/600; SKU 14px monospace; the availability figure
  **28px/700**; components line 14px; labels 13px/600 with 0.06em letter-spacing.
- ≥768px: the same cards in a two-column grid. No new components.

**The long-name fixture (`SEA-9004`, ~124 characters) must be checked at 320px width.** Name
clamps to 2 lines with an ellipsis; full name is revealed on expand. It must not push the
availability block off-screen, wrap it under the name, or expand the card beyond the viewport.

### 4.5 Achromatic palette (D2)

White, grays and black only. **No brand hue. No accent colour. No logo. No company name** —
not Kyrie, not Ascension, not the end client.

```css
--paper:    #ffffff;
--ink:      #000000;
--gray-900: #111111;
--gray-700: #3d3d3d;
--gray-500: #6b6b6b;
--gray-300: #c9c9c9;
--gray-100: #efefef;
--hatch: repeating-linear-gradient(45deg, var(--gray-300) 0 2px, transparent 2px 6px);
```

Body text `--ink` on `--paper` is 21:1. Minimum 7:1 for text, 3:1 for borders and glyphs.
**Achromatic does not mean low contrast** — `--gray-500` is the lightest permitted text colour
and only for secondary text on white (5.7:1); never gray-on-gray.

**No decorative animation. No CSS transitions or keyframe animations at all.** Press feedback
is an instantaneous `:active` border-width change. The loading skeleton is static.

---

## 5. Status encoding — multi-channel, mandatory

D2 makes this binding: status must be legible at a glance **without reading the numbers**,
**not by colour alone**, and — because the palette is achromatic — **not by lightness alone
either**. "The darker one" fails this the same way red/green would.

**Two orthogonal dimensions**, rendered as two separate badges. An item can be Low *and*
Stale, and collapsing those into one scale would hide one of them.

### 5.1 Stock status — four values, from `qty_available`

| Status | Condition | Glyph (distinct silhouette) | Border | Fill | Label text | Position / extra |
|---|---|---|---|---|---|---|
| **In stock** | `available >= low_stock_threshold` | Filled **square** ■ | 2px **solid** | Solid black, white glyph | `IN STOCK` | 4px solid left rule, **full** card height |
| **Low** | `0 < available < low_stock_threshold` | Outlined **triangle** △ with a solid bottom third | 2px **solid** | White, black glyph | `LOW` | 4px solid left rule, **top half** only |
| **None — incoming** | `available <= 0 AND qty_incoming > 0` | **Down-arrow inside a dashed circle** ↓ | 2px **dashed** | White, black glyph | `NONE — INCOMING` + `ETA 4 Sep` | 4px **dashed** left rule, full height |
| **None available** | `available <= 0 AND qty_incoming = 0` | **Circle with a diagonal slash** ⊘ | 2px **dotted** | White, black glyph | `NONE AVAILABLE` | 4px **dotted** left rule + `--hatch` behind the availability block |

Every pair differs on **at least three** channels: glyph silhouette, border style, and label
text. Remove colour and lightness entirely and all four remain distinguishable — that is the
test Builder should apply while writing the CSS, not something to be checked afterward.

Additional rules:

- **Labels are always rendered.** Never icon-only, at any breakpoint. Uppercase, 13px/600.
- Glyphs are inline SVG in `components/icons.tsx` with `aria-hidden="true"`; the label carries
  the accessible name.
- Glyph box 24×24 inside a badge with ≥8px padding.
- The availability figure itself gets a matching fill treatment: inverted solid block for
  In stock, outlined for Low, `--hatch` background for both None states.
- Negative availability renders as the negative number (e.g. `-3`) with **None available**
  treatment, plus the components line for context. It is not clamped to 0 (`SCHEMA.md` §8).

### 5.2 Freshness — additive, orthogonal

Threshold: **`app_settings.stale_after_minutes = 360` (6 hours)**. Read from the database, not
hard-coded, so it is tunable without a deploy.

- `updated_at` newer than the threshold: no freshness badge; the relative age reads in the
  card's metadata line ("updated 4 minutes ago").
- Older: a **second badge** with an outlined **clock** glyph, an **inverted fill** (black
  background, white glyph — distinct from every stock badge, all of which are outlined except
  In stock, whose glyph is a square not a clock), a **dashed 2px outline around the entire
  card**, and the label `STALE · updated 3 days ago`.

Both badges render together when applicable. The stale badge sits after the stock badge in
document order so screen readers announce stock status first.

### 5.3 Relative age — `components/relative-time.tsx`

`lib/relative-time.ts` exports `formatRelativeAge(iso, now)`:

| Age | Output |
|---|---|
| < 60s | `updated just now` |
| < 60min | `updated 4 minutes ago` |
| < 24h | `updated 7 hours ago` |
| < 7d | `updated 3 days ago` |
| otherwise | `updated on 3 Mar 2026` |

**Hydration.** The server renders the absolute short date inside
`<time dateTime={iso} suppressHydrationWarning>`; the client component swaps in the relative
string on mount and re-renders every 60 seconds via `setInterval`. Rendering a relative time
directly on the server produces a hydration mismatch that Next reports as an error — this is
a known trap and the reason for the two-phase render.

Staleness for the *first paint* is computed server-side from a `now` passed down as a prop, so
the stale badge is correct before hydration; the client recomputes on its own tick.

### 5.4 Source attribution

Every card shows, in its metadata line: `QuickBooks`, `QuickBooks (stub)`, or
**`Manual override`**. An override row additionally shows the note and
`overridden by <email or "internal staff"> · <relative time>` when expanded. A rep seeing
whether a number came from QuickBooks or a person is a trust feature and makes the eventual
cutover observable rather than silent.

---

## 6. PWA

`app/manifest.ts` (Next metadata route):

```ts
{
  name: 'Inventory Portal',
  short_name: 'Inventory',
  display: 'standalone',
  start_url: '/inventory',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [192, 512, maskable-512],
}
```

**No company name, no client name, no invented brand.** "Inventory Portal" is a description,
not a brand.

`scripts/generate-icons.mjs` emits achromatic icons deterministically: a black rounded square
containing three white horizontal bars of differing lengths — an abstract list mark. It must
not read as a logo or wordmark, contain letters, or contain colour.

`public/sw.js`: registers, passes every fetch straight through to the network, caches nothing,
and contains **no push handler and no VAPID key**. Its only job is to satisfy Chrome's
installability requirement for a fetch handler. iOS installs from the manifest alone.

**Do not fake a notification permission prompt.** Real Web Push is out of scope.

---

## 7. Seed generator — `scripts/generate-seed.mjs` (D6)

Builder writes a **generator**. It does not hand-author rows as literal content.

- Node, no dependencies, run via `npm run seed:generate`.
- **Deterministic**: a `mulberry32` PRNG with a fixed seed constant (`20260819`) at the top of
  the file. No `Math.random()`, no `Date.now()`. Two runs produce byte-identical output.
- **Both the script and its output are committed**, so the data is reproducible *and*
  reviewable in a diff.
- Output: **SQL insert files** under `supabase/seed/`:
  - `supabase/seed/0001_seed_catalogue.sql` — 90 generated catalogue SKUs + inventory rows
  - `supabase/seed/0002_seed_fixtures.sql` — the pinned fixtures, separate so they are
    reviewable at a glance rather than buried in 90 rows
- Every statement is `INSERT … ON CONFLICT DO NOTHING`, so re-running is safe.

### 7.1 Timestamps — deterministic file, correct at apply time

Seed rows must **not** carry literal timestamps. A file generated today and applied next week
would show every row as days stale, and the freshness feature would be undemonstrable.

Emit **relative SQL expressions**, which are fixed text in the file yet correct whenever
applied:

```sql
updated_at   => now() - interval '17 minutes'
incoming_eta => current_date + 12
```

The interval count is drawn from the seeded PRNG (1–300 minutes for fresh rows), so the file
is byte-stable across runs while the data is always freshly aged on apply.

### 7.2 Catalogue

90 SKUs across 6 categories: Seating, Tables, Storage, Workstations, Lighting, Accessories.

SKU format `^[A-Z]{3}-[0-9]{4}$` — `SEA-`, `TAB-`, `STO-`, `WRK-`, `LGT-`, `ACC-`. The
**9000-block is reserved for fixtures**; the generator never randomly emits `9xxx`.

Names are composed deterministically from invented adjective / line / type / feature word
lists (e.g. "Meridian Stacking Side Chair", "Halden Four-Drawer Lateral File"). **Invented
SKUs and product names. No real client names, no real product names, no logos** (D4 #5).

`qty_committed` is drawn to be plausible relative to `qty_on_hand` (0–60% of it), producing a
realistic spread of statuses across the list without any of them being fixtures.

### 7.3 The pinned fixtures — present on every run, never a random draw

| SKU | Fixture | Values |
|---|---|---|
| `SEA-9001` | **`available` zero but stock incoming** | `on_hand 0, committed 0, incoming 48, incoming_eta = current_date + 12` → status **None — incoming** |
| `SEA-9002` | **`on_hand` and `available` differ sharply** | `on_hand 200, committed 186` → available **14** from an on-hand of 200 |
| `SEA-9003` | **Admin override contradicting the source** | `source='manual_override'`, `on_hand 48, committed 6`, `override_note` recording that a physical count found 12 fewer than QuickBooks reported (which showed 60), `override_at = now() - interval '2 hours'`, `source_payload.last_source_snapshot` carrying the contradicting QuickBooks figure so both numbers are on screen |
| `SEA-9004` | **Long product name threatening mobile layout** | ~124 characters: *"Continental Executive High-Back Ergonomic Swivel Conference Chair with Adjustable Lumbar Support and Polished Aluminium Base"* |
| `SEA-9005` | **Stale row** (added — see note) | `updated_at = now() - interval '3 days'` → **Stale** badge |
| `SEA-9006` | **Last-unit test SKU** (added — see note) | `on_hand 1, committed 0, incoming 0` → available exactly **1** |
| `SEA-9007` | **Delta-ledger baseline** (added — see note) | `on_hand 40, committed 10` → available **30**; the brief's own worked example |

**Note on `SEA-9005`–`9007`.** The brief pins four fixtures; these three are additions, each
in direct service of a stated requirement rather than scope expansion: the stale threshold
cannot be demonstrated without a stale row, and attacks 2 and 3 need deterministic SKUs with
known starting quantities. Recorded as decision A6 in `PLAN.md`.

`SEA-9003`'s override is **seed data** — an inventory row whose `source` reflects an override.
It is **not** step-3 admin editing UI, and no editing interface ships in this run.

### 7.4 `supabase/seed/0003_seed_demo_delta.sql` — hand-written, not generated

Commitments reference `profiles(id)`, which does not exist until the Human creates users. This
file is applied **after** at least one rep exists, and degrades gracefully if not:

```sql
DO $$
DECLARE v_rep uuid; v_admin uuid;
BEGIN
  SELECT id INTO v_rep   FROM public.profiles WHERE role = 'rep'   ORDER BY created_at LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1;

  IF v_admin IS NOT NULL THEN
    UPDATE public.inventory SET override_by = v_admin
     WHERE sku = 'SEA-9003' AND override_by IS NULL;
  END IF;

  IF v_rep IS NULL THEN
    RAISE NOTICE 'No rep profile yet; skipping demo delta. Re-run after a rep signs in.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.commitments) THEN
    RAISE NOTICE 'Commitments already exist; skipping demo delta.';
    RETURN;
  END IF;

  INSERT INTO public.commitments (sku, location, qty, rep_id, state, note)
  VALUES ('SEA-9007', 'default', 6, v_rep, 'pending', 'Demo delta: recorded in portal, not yet in QuickBooks');
END $$;
```

This produces the brief's exact worked example on `SEA-9007`:
`40 on hand · 10 committed in QuickBooks · ⚑ 6 more committed by reps → 24 available`,
which makes the show-both-numbers presentation demoable without any step-2 UI.

### 7.5 No credentials, anywhere

No passwords, keys, tokens, or plausible-looking placeholders in the generator or its output —
**not even fake ones** (D6). Magic-link auth means there are no passwords to placeholder in
the first place. Any email addresses used in seed or verification data use the reserved
non-routable `example.invalid` domain. `scripts/check-no-secrets.sh` greps for this.
