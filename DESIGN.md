# Design system — read before writing ANY UI

This app is **Next.js 15 (App Router) + CSS Modules**. No Tailwind, no shadcn.
Styling is CSS variables (`app/globals.css`) consumed through per-component
`*.module.css`. Motion is **framer-motion** for anything that mounts/unmounts, and
CSS transitions/keyframes for in-place state. Follow this contract; do not invent
taste, and do not reach for tools this app doesn't use.

Identity: **Ascension IT** — warm paper ground, **navy** primary (`--accent`
`#0a2c4d`), **cyan** signature (`--brand-cyan` `#1db9e1`, highlight only, never
text), display serif **Fraunces**, UI sans **Hanken Grotesk**.

---

## Colors — tokens only
Every color resolves through a CSS variable defined in `app/globals.css :root`.
- Use: `var(--paper)` (page), `var(--surface)` (cards), `var(--surface-sunk)`
  (wells/loading), `var(--ink)` / `--ink-soft` / `--ink-faint` (text, in that
  contrast order), `var(--line)` / `--line-soft` (borders), `var(--accent)` /
  `--accent-deep` / `--accent-tint` / `--accent-line` (brand + interaction),
  `var(--brand-cyan)` / `--brand-cyan-deep` (highlight only), `var(--mark)`
  (status ink).
- **NEVER** write a raw color in a component or module: no `#fff`, `#000`, `#hex`,
  `white`, `black`, `rgb(...)`. A new color becomes a **token in `:root` first.**
- Status is **never carried by color alone** (accessibility floor): shape + glyph +
  label + border style + left-rule, per the block in `globals.css`. Don't regress this.

## Type — three jobs
- Headings, figures, eyebrows, primary button labels: **`var(--font-display)`** (Fraunces).
- Body / reading copy / most UI text: **`var(--font-body)`** (Hanken Grotesk).
- Numeric SKUs/codes: `var(--font-mono)`.
- **Inputs are ≥16px** (`--text-base`) so iOS doesn't zoom on focus. Never shrink an input font below that.
- Eyebrow label = `var(--font-body)` (or display), `var(--text-label)` (12px), `text-transform: uppercase`, `letter-spacing`, `var(--ink-faint)`.

## Surface hierarchy (4 levels, consistent)
1. Page ground — `var(--paper)`
2. Card — `background: var(--surface)`, `border: var(--border-width) solid var(--line)`, `border-radius: var(--radius)`, `box-shadow: var(--shadow-card)`
3. Elevated / modal — `var(--surface)` + `var(--shadow-pop)`
4. Chip / pill — `border-radius: var(--radius-pill)`, `border` + tint, ~12–14px label, optional glyph
> On `.card` in `inventory-row.module.css`, **never** use `border`/`background`
> shorthand — it wipes the status left-rule. Set longhands only.

## Motion — the contract (non-negotiable)
Tokens live in `globals.css`: `--ease-expo` `cubic-bezier(0.16, 1, 0.3, 1)` (the one
curve — fast in, long soft settle), durations `--dur-1..4` (130–520ms).

- **One easing curve** on everything: `var(--ease-expo)`. Durations 130–580ms. No `ease-in-out`.
- **Overlays / anything that unmounts (modals, sheets, toasts, list items that can be
  removed) use framer-motion `AnimatePresence` with an `exit`** — CSS cannot animate an
  element React just removed. A modal that hard-unmounts on close is a bug.
- **Entrances animate multiple properties together** — `opacity` + `y` + `scale`
  (+ `blur` for hero surfaces) — and **stagger children** by 0.05–0.24s
  (container → header → body). See `components/motion.tsx` helpers.
- **Every clickable acknowledges touch instantly**: a `transition` plus
  `:active { transform: scale(0.96–0.98) }`. Nothing changes state with zero transition.
- **Async buttons show a pending state**: on click, `disabled` + swap the label to
  `<span className="spinner" />` + verb ("Saving…"). Never a dead button that then
  jump-cuts to a result. (`SubmitButton` does this for server actions; do the same for fetches.)
- **Loading regions use a skeleton** (`className="skeleton"` or `<Skeleton/>`), never
  blank space and never a bare centered spinner on an empty page.
- **Prefer optimistic updates with rollback** over waiting on the network, when the
  action is reversible. Roll back + error message on failure.
- **Respect `prefers-reduced-motion`** — globals neutralizes all animation there; don't override it.

## Layout & mobile
- Vertical rhythm: `gap`/`space` on the `--space-*` scale (cards interiors ~`--space-4`).
- Cards: `var(--surface)` + `var(--line)` + `var(--radius)` + `--shadow-card`.
- Modals: **full-screen on mobile** (`position: fixed; inset: 0`), **centered card `≥768px`**
  (`max-width: min(42rem, calc(100vw - 2rem))`).
- **Safe areas**: any fixed top/bottom element pads with `env(safe-area-inset-*)`.
- Scroll containers: `overscroll-behavior: contain` + `-webkit-overflow-scrolling: touch`.
- **Tap targets ≥ 44px** (`--tap-chip`); primary CTAs `--tap` (48px).

## Feedback & navigation
- Inline status uses `role="status"` (success) / `role="alert"` (error).
- **Success messages fire only on confirmed success**, never optimistically-unconditionally.
- Nav is a single top bar with wrapping tabs (all tabs always visible — never a hidden
  scroll strip). Deep content opens in an in-app modal (`DocViewer`) rather than leaving the app.

## Forbidden
- Raw hex / named colors in components. Emojis in product UI. Status by color alone.
- Instant appear **or disappear** on any overlay (must have enter AND exit).
- Inter/system font for headings (headings are Fraunces). Inputs < 16px.
- `border`/`background` shorthand on `.card` (kills the status rule).

## How to prompt / build against this
Describe **behavior**, not looks: *"Add a Save button. Pending: disabled + spinner.
Success: optimistic list update + status message. Failure: rollback + error. The new
row enters with the standard stagger; removal animates out via AnimatePresence."*
