#!/usr/bin/env node
/**
 * Deterministic seed generator.  `npm run seed:generate`
 *
 * Writes:
 *   supabase/seed/0001_seed_catalogue.sql   90 generated catalogue SKUs + inventory rows
 *   supabase/seed/0002_seed_fixtures.sql    the 7 pinned fixtures
 *
 * Rules this file obeys, all of them deliberate:
 *
 *  - DETERMINISTIC. A mulberry32 PRNG with a fixed seed constant. No Math.random(), no
 *    Date.now(). Two runs produce byte-identical output, so the committed output is
 *    reviewable in a diff.
 *
 *  - NO LITERAL TIMESTAMPS. Rows emit relative SQL expressions -- now() - interval 'N
 *    minutes', current_date + N -- which are fixed text in the file yet correct whenever the
 *    file is applied. A file generated today and applied next week must not show every row
 *    as days stale; freshness would be undemonstrable.
 *
 *  - NO CREDENTIALS OF ANY KIND. No passwords, keys, tokens, or plausible-looking
 *    placeholders -- not even fake ones. Magic-link auth means there are no passwords to
 *    placeholder in the first place. Any email address used anywhere in seed or
 *    verification data uses the reserved, non-routable example.invalid domain.
 *
 *  - INVENTED SKUS AND PRODUCT NAMES. No real client names, no real product names, no
 *    logos, no brand.
 *
 *  - THE PINNED FIXTURES ARE PINNED. They are emitted unconditionally, never drawn from the
 *    PRNG, so they are present on every run rather than depending on chance.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = join(HERE, '..', 'supabase', 'seed')

/* ------------------------------------------------------------------ *
 * Deterministic PRNG
 * ------------------------------------------------------------------ */

const PRNG_SEED = 20260819

function mulberry32(a) {
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(PRNG_SEED)

/** Integer in [min, max] inclusive. */
const int = (min, max) => min + Math.floor(rand() * (max - min + 1))
/** Uniform pick. */
const pick = (arr) => arr[int(0, arr.length - 1)]
/** True with probability p. */
const chance = (p) => rand() < p

/* ------------------------------------------------------------------ *
 * Catalogue vocabulary -- invented, generic, furniture-industry
 * ------------------------------------------------------------------ */

const LINES = [
  'Meridian', 'Halden', 'Corbel', 'Ashgrove', 'Kestrel', 'Fenwick', 'Bramble',
  'Larkspur', 'Trentham', 'Wexford', 'Alder', 'Ravensworth', 'Sable', 'Cobalt Hill',
  'Northrop', 'Pemberton', 'Quillon', 'Stanmore', 'Verity', 'Whitlock',
]

/**
 * Qualifiers and materials are scoped PER CATEGORY. A shared pool produces nonsense like
 * "Two-Drawer Side Chair" or "Glass-Top Guest Chair", which reads as obviously synthetic in
 * a client demo. The point of the seed data is that it is credible enough to search and
 * filter against realistically.
 */
const CATEGORIES = [
  {
    name: 'Seating',
    prefix: 'SEA',
    types: [
      'Side Chair', 'Stacking Chair', 'Task Chair', 'Lounge Chair', 'Bar Stool',
      'Guest Chair', 'Executive Chair', 'Bench Seat', 'Two-Seat Sofa', 'Ottoman',
      'Drafting Stool', 'Visitor Chair',
    ],
    qualifiers: [
      'Compact', 'Stackable', 'Folding', 'Contoured', 'Slimline', 'High-Back',
      'Low-Profile', 'Heavy-Duty', 'Swivel', 'Armless',
    ],
    materials: [
      'Mesh-Back', 'Upholstered', 'Powder-Coated', 'Solid-Beech', 'Felt-Panelled',
      'Brushed-Steel', 'Moulded-Shell',
    ],
    onHand: [0, 420],
    threshold: [8, 30],
  },
  {
    name: 'Tables',
    prefix: 'TAB',
    types: [
      'Conference Table', 'Dining Table', 'Occasional Table', 'Coffee Table',
      'Training Table', 'Cafe Table', 'Side Table', 'Boardroom Table',
    ],
    qualifiers: [
      'Compact', 'Wide', 'Folding', 'Extended', 'Nesting', 'Round',
      'Height-Adjustable', 'Modular', 'Flip-Top',
    ],
    materials: [
      'Oak-Veneer', 'Laminate-Top', 'Glass-Top', 'Walnut-Finish', 'Solid-Beech',
      'Powder-Coated',
    ],
    onHand: [0, 60],
    threshold: [2, 8],
  },
  {
    name: 'Storage',
    prefix: 'STO',
    types: [
      'Lateral File', 'Bookcase', 'Storage Cabinet', 'Credenza', 'Wardrobe Unit',
      'Mobile Pedestal', 'Shelving Unit', 'Locker Bank', 'Tambour Cupboard',
    ],
    qualifiers: [
      'Wide', 'Tall', 'Compact', 'Lockable', 'Modular', 'Double-Sided', 'Open-Front',
    ],
    materials: [
      'Oak-Veneer', 'Walnut-Finish', 'Powder-Coated', 'Laminate-Top', 'Brushed-Steel',
    ],
    // Drawer counts only attach to the types that actually have drawers.
    drawerTypes: ['Lateral File', 'Mobile Pedestal', 'Storage Cabinet', 'Credenza'],
    drawers: ['Two-Drawer', 'Three-Drawer', 'Four-Drawer'],
    onHand: [0, 140],
    threshold: [4, 14],
  },
  {
    name: 'Workstations',
    prefix: 'WRK',
    types: [
      'Sit-Stand Desk', 'Corner Workstation', 'Bench Desk', 'Reception Counter',
      'Compact Desk', 'Screen Panel', 'Return Unit',
    ],
    qualifiers: [
      'Wide', 'Double-Sided', 'Modular', 'Height-Adjustable', 'Extended',
      'Left-Hand', 'Right-Hand', 'Single-Bay',
    ],
    materials: [
      'Oak-Veneer', 'Laminate-Top', 'Walnut-Finish', 'Powder-Coated', 'Felt-Panelled',
    ],
    onHand: [0, 90],
    threshold: [3, 12],
  },
  {
    name: 'Lighting',
    prefix: 'LGT',
    types: [
      'Task Lamp', 'Floor Lamp', 'Pendant Light', 'Desk Lamp', 'Wall Sconce',
      'Under-Shelf Light', 'Clamp Light',
    ],
    qualifiers: [
      'Slimline', 'Adjustable', 'Dimmable', 'Compact', 'Twin-Head', 'Low-Profile',
    ],
    materials: ['Brushed-Steel', 'Powder-Coated', 'Matt-Black', 'Frosted-Glass'],
    onHand: [0, 260],
    threshold: [10, 35],
  },
  {
    name: 'Accessories',
    prefix: 'ACC',
    types: [
      'Monitor Arm', 'Cable Tray', 'Coat Stand', 'Waste Bin', 'Footrest',
      'Whiteboard', 'Planter Box', 'Entrance Mat', 'Keyboard Tray', 'Privacy Screen',
    ],
    qualifiers: [
      'Compact', 'Wide', 'Heavy-Duty', 'Modular', 'Slimline', 'Twin', 'Adjustable',
    ],
    materials: ['Powder-Coated', 'Brushed-Steel', 'Felt-Panelled', 'Moulded-Plastic'],
    onHand: [0, 600],
    threshold: [15, 60],
  },
]

/** How many of the 90 generated rows each category gets. Sums to 90. */
const CATEGORY_COUNTS = { Seating: 22, Tables: 13, Storage: 15, Workstations: 13, Lighting: 12, Accessories: 15 }

const CATALOGUE_TOTAL = Object.values(CATEGORY_COUNTS).reduce((a, b) => a + b, 0)

/* ------------------------------------------------------------------ *
 * SQL helpers
 * ------------------------------------------------------------------ */

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
const jsonb = (obj) => `${q(JSON.stringify(obj))}::jsonb`
const minutesAgo = (n) => `now() - interval '${n} minutes'`
const daysAgo = (n) => `now() - interval '${n} days'`
const daysAhead = (n) => `current_date + ${n}`

/* ------------------------------------------------------------------ *
 * Catalogue generation
 * ------------------------------------------------------------------ */

function generateCatalogue() {
  const products = []
  const inventory = []
  const usedNames = new Set()

  for (const category of CATEGORIES) {
    const count = CATEGORY_COUNTS[category.name]
    // SKU numbers walk a deterministic sequence inside each category's own block.
    // The 9000-block is reserved for fixtures and is never reached: the sequence starts
    // at 1000 and the largest category takes 22 steps of at most 40.
    let n = 1000

    for (let i = 0; i < count; i += 1) {
      n += int(7, 40)
      const sku = `${category.prefix}-${String(n).padStart(4, '0')}`

      let name = ''
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const type = pick(category.types)
        const parts = [pick(LINES)]
        if (category.drawerTypes?.includes(type) && chance(0.7)) {
          parts.push(pick(category.drawers))
        } else if (chance(0.55)) {
          parts.push(pick(category.qualifiers))
        }
        if (chance(0.4)) parts.push(pick(category.materials))
        parts.push(type)
        name = parts.join(' ')
        if (!usedNames.has(name)) break
      }
      usedNames.add(name)

      const lowStockThreshold = int(category.threshold[0], category.threshold[1])

      // Quantities. qty_committed is drawn to be plausible relative to qty_on_hand
      // (0-60% of it), producing a realistic spread of statuses across the list without
      // any of them being a fixture.
      const onHand = int(category.onHand[0], category.onHand[1])
      const committed = Math.round(onHand * (rand() * 0.6))
      const hasIncoming = chance(0.28)
      const incoming = hasIncoming ? int(6, 240) : 0
      const eta = hasIncoming ? int(3, 45) : null

      // Freshness: catalogue rows are fresh (1-300 minutes). The stale case is a pinned
      // fixture (SEA-9005), not a random draw, so the stale threshold is demonstrable on
      // every run rather than by luck.
      const ageMinutes = int(1, 300)

      products.push({ sku, name, category: category.name, uom: 'EA', lowStockThreshold })
      inventory.push({
        sku,
        onHand,
        committed,
        incoming,
        eta,
        ageMinutes,
        payload: {
          sku,
          location: 'default',
          qty_on_hand: onHand,
          qty_committed: committed,
          qty_incoming: incoming,
          incoming_eta: eta === null ? null : `+${eta}d`,
          source: 'quickbooks_stub',
          note: 'Synthetic stub payload. Shape mirrors what the adapter returns.',
        },
      })
    }
  }

  return { products, inventory }
}

/* ------------------------------------------------------------------ *
 * The pinned fixtures -- present on every run, never a random draw
 * ------------------------------------------------------------------ */

const LONG_NAME =
  'Continental Executive High-Back Ergonomic Swivel Conference Chair with Adjustable Lumbar Support and Polished Aluminium Base'

const FIXTURES = [
  {
    sku: 'SEA-9001',
    name: 'Kestrel Stackable Guest Chair',
    category: 'Seating',
    lowStockThreshold: 10,
    onHand: 0,
    committed: 0,
    incoming: 48,
    etaDays: 12,
    ageMinutes: 22,
    source: 'quickbooks_stub',
    why: 'available at zero but stock incoming -> status "NONE - INCOMING"',
  },
  {
    sku: 'SEA-9002',
    name: 'Meridian Contoured Mesh-Back Task Chair',
    category: 'Seating',
    lowStockThreshold: 20,
    onHand: 200,
    committed: 186,
    incoming: 0,
    etaDays: null,
    ageMinutes: 41,
    source: 'quickbooks_stub',
    why: 'on_hand and available differ sharply -> available 14 out of an on-hand of 200',
  },
  {
    sku: 'SEA-9003',
    name: 'Halden Upholstered Executive Chair',
    category: 'Seating',
    lowStockThreshold: 6,
    onHand: 48,
    committed: 6,
    incoming: 0,
    etaDays: null,
    ageMinutes: 120,
    source: 'manual_override',
    overrideNote:
      'Physical count on the warehouse floor found 48 units. QuickBooks reported 60 - twelve fewer are actually here. Portal figure stands until the source is corrected.',
    overrideAgoMinutes: 120,
    sourceSnapshot: { sku: 'SEA-9003', location: 'default', qty_on_hand: 60, qty_committed: 6, qty_incoming: 0, incoming_eta: null, source: 'quickbooks_stub' },
    why: 'admin override that contradicts the source number, attributed and timestamped (seed DATA, not step-3 editing UI)',
  },
  {
    sku: 'SEA-9004',
    name: LONG_NAME,
    category: 'Seating',
    lowStockThreshold: 4,
    onHand: 26,
    committed: 9,
    incoming: 12,
    etaDays: 21,
    ageMinutes: 8,
    source: 'quickbooks_stub',
    why: `product name long enough to threaten a mobile layout (${LONG_NAME.length} characters)`,
  },
  {
    sku: 'SEA-9005',
    name: 'Fenwick Folding Bench Seat',
    category: 'Seating',
    lowStockThreshold: 8,
    onHand: 64,
    committed: 21,
    incoming: 0,
    etaDays: null,
    ageDays: 3,
    source: 'quickbooks_stub',
    why: 'stale row -> updated 3 days ago, past the 360-minute threshold, so the STALE badge is demonstrable',
  },
  {
    sku: 'SEA-9006',
    name: 'Corbel Drafting Stool',
    category: 'Seating',
    lowStockThreshold: 5,
    onHand: 1,
    committed: 0,
    incoming: 0,
    etaDays: null,
    ageMinutes: 15,
    source: 'quickbooks_stub',
    why: 'last-unit SKU -> availability of exactly 1; the contended row in the concurrency attack',
  },
  {
    sku: 'SEA-9007',
    name: 'Ashgrove Laminate-Top Training Table',
    category: 'Tables',
    lowStockThreshold: 6,
    onHand: 40,
    committed: 10,
    incoming: 0,
    etaDays: null,
    ageMinutes: 63,
    source: 'quickbooks_stub',
    why: "delta-ledger baseline -> 40 on hand, 10 committed, available 30; the brief's own worked example",
  },
]

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

const BANNER = (title, note) => `-- ${'-'.repeat(74)}
-- ${title}
--
-- GENERATED FILE. Do not edit by hand -- edit scripts/generate-seed.mjs and re-run
-- \`npm run seed:generate\`. The generator is deterministic (mulberry32, fixed seed
-- ${PRNG_SEED}), so regenerating produces byte-identical output.
--
${note
  .split('\n')
  .map((l) => `--${l ? ` ${l}` : ''}`)
  .join('\n')}
--
-- Contains no credentials of any kind. Timestamps are relative expressions, so the data is
-- correctly aged whenever the file is applied.
-- ${'-'.repeat(74)}
`

function emitCatalogue({ products, inventory }) {
  const lines = []
  lines.push(
    BANNER(
      `0001_seed_catalogue.sql -- ${products.length} catalogue SKUs across ${CATEGORIES.length} categories`,
      'Apply after migrations 0001-0012, in the Supabase SQL editor.\nEvery statement is ON CONFLICT DO NOTHING, so re-running is safe.\n\nThe 9000-block is reserved for the pinned fixtures in 0002 and never appears here.',
    ),
  )
  lines.push('')
  lines.push('INSERT INTO public.products (sku, name, category, uom, low_stock_threshold) VALUES')
  lines.push(
    products
      .map(
        (p) =>
          `  (${q(p.sku)}, ${q(p.name)}, ${q(p.category)}, ${q(p.uom)}, ${p.lowStockThreshold})`,
      )
      .join(',\n'),
  )
  lines.push('ON CONFLICT (sku) DO NOTHING;')
  lines.push('')
  lines.push(
    'INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload, updated_at) VALUES',
  )
  lines.push(
    inventory
      .map(
        (r) =>
          `  (${q(r.sku)}, 'default', ${r.onHand}, ${r.committed}, ${r.incoming}, ` +
          `${r.eta === null ? 'NULL' : daysAhead(r.eta)}, 'quickbooks_stub', ${jsonb(r.payload)}, ${minutesAgo(r.ageMinutes)})`,
      )
      .join(',\n'),
  )
  lines.push('ON CONFLICT (sku, location) DO NOTHING;')
  lines.push('')
  return lines.join('\n')
}

function emitFixtures() {
  const lines = []
  lines.push(
    BANNER(
      '0002_seed_fixtures.sql -- the pinned fixtures',
      [
        'Apply after 0001_seed_catalogue.sql.',
        '',
        'These are deliberately awkward cases, kept in their own file so they are reviewable',
        'at a glance rather than buried among 90 generated rows. They are PINNED: emitted',
        'unconditionally on every run, never drawn from the PRNG.',
        '',
        ...FIXTURES.map((f) => `  ${f.sku}  ${f.why}`),
      ].join('\n'),
    ),
  )
  lines.push('')
  lines.push('INSERT INTO public.products (sku, name, category, uom, low_stock_threshold) VALUES')
  lines.push(
    FIXTURES.map(
      (f) => `  (${q(f.sku)}, ${q(f.name)}, ${q(f.category)}, 'EA', ${f.lowStockThreshold})`,
    ).join(',\n'),
  )
  lines.push('ON CONFLICT (sku) DO NOTHING;')
  lines.push('')

  // Non-override fixtures.
  const plain = FIXTURES.filter((f) => f.source !== 'manual_override')
  lines.push(
    'INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload, updated_at) VALUES',
  )
  lines.push(
    plain
      .map((f) => {
        const payload = {
          sku: f.sku,
          location: 'default',
          qty_on_hand: f.onHand,
          qty_committed: f.committed,
          qty_incoming: f.incoming,
          incoming_eta: f.etaDays === null || f.etaDays === undefined ? null : `+${f.etaDays}d`,
          source: 'quickbooks_stub',
          note: 'Synthetic stub payload. Shape mirrors what the adapter returns.',
        }
        const age = f.ageDays ? daysAgo(f.ageDays) : minutesAgo(f.ageMinutes)
        const eta = f.etaDays === null || f.etaDays === undefined ? 'NULL' : daysAhead(f.etaDays)
        return `  (${q(f.sku)}, 'default', ${f.onHand}, ${f.committed}, ${f.incoming}, ${eta}, 'quickbooks_stub', ${jsonb(payload)}, ${age})`
      })
      .join(',\n'),
  )
  lines.push('ON CONFLICT (sku, location) DO NOTHING;')
  lines.push('')

  // The override fixture, with its own commentary because it carries the attribution fields.
  for (const f of FIXTURES.filter((x) => x.source === 'manual_override')) {
    lines.push(`-- ${f.sku}: an admin override that CONTRADICTS the source figure.`)
    lines.push('--')
    lines.push('-- source_payload.last_source_snapshot carries what QuickBooks claimed, so both numbers')
    lines.push('-- are on screen and the portal never silently overrides. override_note and override_at')
    lines.push('-- are NOT NULL for an override row -- the inventory_override_is_attributed CHECK in')
    lines.push('-- migration 0004 enforces that at the database layer rather than trusting the UI.')
    lines.push('--')
    lines.push('-- override_by is left NULL here because no admin user exists at seed time. It is')
    lines.push('-- backfilled by 0003_seed_demo_delta.sql once the Human has created one.')
    lines.push('--')
    lines.push('-- This is seed DATA. No admin editing interface ships in this run.')
    lines.push(
      'INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload, override_note, override_at, updated_at) VALUES',
    )
    lines.push(
      `  (${q(f.sku)}, 'default', ${f.onHand}, ${f.committed}, ${f.incoming}, NULL, 'manual_override',
   ${jsonb({ last_source_snapshot: f.sourceSnapshot, last_source_seen_at: 'recorded at sync time' })},
   ${q(f.overrideNote)},
   ${minutesAgo(f.overrideAgoMinutes)},
   ${minutesAgo(f.ageMinutes)})`,
    )
    lines.push('ON CONFLICT (sku, location) DO NOTHING;')
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */

const catalogue = generateCatalogue()

if (catalogue.products.length !== CATALOGUE_TOTAL) {
  throw new Error(`expected ${CATALOGUE_TOTAL} catalogue rows, generated ${catalogue.products.length}`)
}
const skus = new Set(catalogue.products.map((p) => p.sku))
if (skus.size !== catalogue.products.length) {
  throw new Error('catalogue SKU collision - the sequence step is too small')
}
for (const sku of skus) {
  if (/-9\d{3}$/.test(sku)) throw new Error(`catalogue emitted a reserved 9000-block SKU: ${sku}`)
  if (!/^[A-Z]{3}-[0-9]{4}$/.test(sku)) throw new Error(`SKU fails the products_sku_format CHECK: ${sku}`)
}
for (const f of FIXTURES) {
  if (!/^[A-Z]{3}-[0-9]{4}$/.test(f.sku)) throw new Error(`fixture SKU fails the CHECK: ${f.sku}`)
}

mkdirSync(SEED_DIR, { recursive: true })
writeFileSync(join(SEED_DIR, '0001_seed_catalogue.sql'), emitCatalogue(catalogue), 'utf8')
writeFileSync(join(SEED_DIR, '0002_seed_fixtures.sql'), emitFixtures(), 'utf8')

const total = catalogue.products.length + FIXTURES.length
process.stdout.write(
  `seed generated (PRNG seed ${PRNG_SEED})\n` +
    `  supabase/seed/0001_seed_catalogue.sql  ${catalogue.products.length} SKUs across ${CATEGORIES.length} categories\n` +
    `  supabase/seed/0002_seed_fixtures.sql   ${FIXTURES.length} pinned fixtures\n` +
    `  ${total} products total\n`,
)
