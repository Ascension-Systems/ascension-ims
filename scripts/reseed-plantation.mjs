/**
 * Re-skins the demo catalogue as Plantation Prestige's actual product world — commercial
 * OUTDOOR furniture and umbrellas — and restores a realistic stock spread.
 *
 * WHY THIS EXISTS
 *   1. The seed catalogue was generic OFFICE furniture (desks, filing, task lighting). For a
 *      demo to Plantation Prestige it should read as their catalogue: umbrellas, chaise
 *      lounges, dining sets, in their real collection names (Durango, Laguna).
 *   2. The simulated live feed (drift_inventory, migration 0018) is a random walk with a floor
 *      at zero and a slight upward bias from landing deliveries. After days of 10-minute ticks
 *      it had pushed 95 of 97 lines into "in stock" — which makes the new status COLOURS
 *      (red/amber, Levon 2026-08-24) invisible, because nothing is out of stock. This resets
 *      the designed spread so every status is represented on screen.
 *
 * SAFETY
 *   - UPDATES IN PLACE. It never deletes or inserts, so nothing referencing a sku by foreign
 *     key (commitments, documents) can break, and SKUs — which are opaque codes — are kept.
 *   - Rows carrying a manual_override are SKIPPED for quantities, so the override demo (an
 *     admin correction contradicting the source) survives intact.
 *   - Deterministic: names are derived from a hash of the sku, so re-running produces the same
 *     catalogue rather than churning it.
 *
 *   node scripts/reseed-plantation.mjs            (apply)
 *   node scripts/reseed-plantation.mjs --dry-run  (print what would change)
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const DRY = process.argv.includes('--dry-run')

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/* ---------------- deterministic PRNG, keyed per sku ---------------- */
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rngFor(sku) {
  let a = hash(sku)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

/* ---------------- Plantation Prestige vocabulary ---------------- */
// Durango and Laguna are their real, published collections; the rest are plausible
// coastal/hospitality collection names in the same register.
const COLLECTIONS = [
  'Durango', 'Laguna', 'Sanibel', 'Coronado', 'Monterey', 'Savannah', 'Charleston',
  'Key West', 'Palmetto', 'Amelia', 'Biscayne', 'Captiva', 'Catalina', 'Marbella',
  'Seaside', 'Bayshore', 'Verandah', 'Magnolia', 'Windward', 'Harbour',
]

/**
 * Qualifiers are scoped PER CATEGORY for the same reason the original generator scoped them:
 * a shared pool produces nonsense a client notices immediately — the first pass of this script
 * emitted "Armless Towel Valet" and "Swivel Ash Urn". Only categories where a qualifier can
 * sensibly apply get one; the rest are keyed to an empty pool and take none.
 */
const QUALIFIERS_BY_CATEGORY = {
  Seating: ['Stackable', 'Armless', 'High-Back', 'Deep-Seating', 'Swivel', 'Commercial-Grade', 'Weather-Resistant'],
  Tables: ['Folding', 'Nesting', 'Wide', 'Round', 'Commercial-Grade', 'Weather-Resistant'],
  Umbrellas: ['Wind-Vented', 'Crank-Lift', 'Push-Up', 'Commercial-Grade', 'Heavy-Duty'],
  Loungers: ['Stackable', 'Nesting', 'Adjustable-Back', 'Wheeled', 'Commercial-Grade'],
  'Cushions & Slings': ['Quick-Dry', 'Fade-Resistant', 'Reversible', 'Replacement'],
  Accessories: ['Heavy-Duty', 'Wheeled', 'Weighted', 'Compact'],
}
const MATERIALS = [
  'Cast-Aluminum', 'Powder-Coated', 'Teak', 'All-Weather Wicker', 'Resin-Wicker',
  'Marine-Grade Polymer', 'Stainless-Steel', 'Textilene', 'Sunbrella', 'HDPE',
]

/**
 * Keyed on the SKU PREFIX, not on the row's current category.
 *
 * This script must be IDEMPOTENT. Keying on the current category made the second run map
 * already-converted rows ("Umbrellas") through a table that only knew the original office
 * categories, so they fell to the default and collapsed into Accessories. The prefix is part
 * of the primary key and never changes, so deriving from it is stable no matter how many
 * times this runs.
 */
const PREFIX_MAP = { SEA: 'Seating', TAB: 'Tables', STO: 'Storage', WRK: 'Workstations', LGT: 'Lighting', ACC: 'Accessories' }

/** Original (office) category -> Plantation Prestige (outdoor) category and its product types. */
const REMAP = {
  Seating: {
    name: 'Seating',
    types: ['Dining Chair', 'Stacking Side Chair', 'Armchair', 'Bar Stool', 'Counter Stool',
      'Sling Chair', 'Deep-Seating Sofa', 'Loveseat', 'Ottoman', 'Bench', 'Swivel Rocker', 'Club Chair'],
  },
  Tables: {
    name: 'Tables',
    types: ['Dining Table', 'Bar Table', 'Counter Table', 'Side Table', 'Coffee Table',
      'Balcony Table', 'Cafe Table', 'Console Table'],
  },
  Storage: {
    name: 'Umbrellas',
    types: ['Market Umbrella', 'Cantilever Umbrella', 'Center-Post Umbrella', 'Offset Umbrella',
      'Patio Umbrella', 'Tilt Umbrella'],
  },
  Workstations: {
    name: 'Loungers',
    types: ['Chaise Lounge', 'Stacking Chaise', 'Sun Lounger', 'Daybed', 'Nesting Lounger', 'Wave Lounger'],
  },
  Lighting: {
    name: 'Cushions & Slings',
    types: ['Seat Cushion', 'Back Cushion', 'Chaise Cushion', 'Replacement Sling', 'Throw Pillow', 'Cushion Set'],
  },
  Accessories: {
    name: 'Accessories',
    types: ['Umbrella Base', 'Umbrella Cover', 'Furniture Cover', 'Side Tray', 'Planter',
      'Serving Cart', 'Ash Urn', 'Towel Valet'],
  },
}

function makeName(sku, _currentCategory, r) {
  const origin = PREFIX_MAP[sku.slice(0, 3)] ?? 'Accessories'
  const spec = REMAP[origin] ?? REMAP.Accessories
  const quals = QUALIFIERS_BY_CATEGORY[spec.name] ?? []
  const parts = [pick(r, COLLECTIONS)]
  if (quals.length && r() < 0.45) parts.push(pick(r, quals))
  // Cushions and slings are fabric goods; a "Teak Seat Cushion" reads as wrong.
  if (spec.name !== 'Cushions & Slings' && r() < 0.4) parts.push(pick(r, MATERIALS))
  parts.push(pick(r, spec.types))
  return { name: parts.join(' '), category: spec.name }
}

async function main() {
  const { data: products, error: pe } = await svc
    .from('products')
    .select('sku, name, category, low_stock_threshold')
    .order('sku')
  if (pe) throw new Error(`read products: ${pe.message}`)

  const { data: inv, error: ie } = await svc
    .from('inventory')
    .select('sku, location, source')
  if (ie) throw new Error(`read inventory: ${ie.message}`)
  const sourceOf = new Map(inv.map((r) => [`${r.sku}|${r.location}`, r.source]))

  const bands = { 'in-stock': 0, low: 0, 'none-incoming': 0, none: 0, skipped: 0 }
  const catCounts = {}
  let renamed = 0

  for (const p of products) {
    const r = rngFor(p.sku)
    const { name, category } = makeName(p.sku, p.category, r)
    catCounts[category] = (catCounts[category] ?? 0) + 1

    if (!DRY) {
      const { error } = await svc.from('products').update({ name, category }).eq('sku', p.sku)
      if (error) throw new Error(`update ${p.sku}: ${error.message}`)
    }
    renamed += 1

    // ---- quantities: restore the designed status spread ----
    const key = `${p.sku}|default`
    if (sourceOf.get(key) === 'manual_override') {
      bands.skipped += 1
      continue
    }

    // A SEPARATE stream for quantities. Sharing `r` with makeName() skewed the band draw,
    // because the name generator consumes a variable number of values (its qualifier/material
    // are conditional) — which starved the "low" band to ~6% of a catalogue that should show
    // ~20% amber. Keyed on the same sku, so this stays deterministic.
    const r2 = rngFor(`${p.sku}|qty`)
    const threshold = p.low_stock_threshold ?? 5
    const roll = r2()
    const band = roll < 0.5 ? 'in-stock' : roll < 0.7 ? 'low' : roll < 0.85 ? 'none-incoming' : 'none'
    bands[band] += 1

    let onHand = 0
    let committed = 0
    let incoming = 0
    let eta = null

    if (band === 'none' || band === 'none-incoming') {
      // available <= 0 is only honestly reachable at nothing-on-the-shelf.
      onHand = 0
      committed = 0
      if (band === 'none-incoming') {
        incoming = int(r2, 6, 240)
        eta = new Date(Date.now() + int(r2, 3, 45) * 864e5).toISOString().slice(0, 10)
      }
    } else {
      const available =
        band === 'low'
          ? int(r2, 1, Math.max(1, threshold - 1))
          : int(r2, threshold + 1, Math.max(threshold + 2, threshold * 6))
      // committed <= 1.5*available keeps committed <= 60% of on_hand by construction.
      committed = int(r2, 0, Math.floor(available * 1.5))
      onHand = available + committed
      if (r2() < 0.28) {
        incoming = int(r2, 6, 240)
        eta = new Date(Date.now() + int(r2, 3, 45) * 864e5).toISOString().slice(0, 10)
      }
    }

    // ~8% of rows are deliberately stale so the freshness badge stays demonstrable.
    const stale = r2() < 0.08
    const updatedAt = new Date(Date.now() - (stale ? int(r2, 7, 72) * 36e5 : int(r2, 1, 300) * 6e4)).toISOString()

    if (!DRY) {
      const { error } = await svc
        .from('inventory')
        .update({
          qty_on_hand: onHand,
          qty_committed: committed,
          qty_incoming: incoming,
          incoming_eta: eta,
          updated_at: updatedAt,
        })
        .eq('sku', p.sku)
        .eq('location', 'default')
      if (error) throw new Error(`inventory ${p.sku}: ${error.message}`)
    }
  }

  console.log(DRY ? '\n--- DRY RUN, nothing written ---' : '\n--- applied ---')
  console.log(`products re-skinned: ${renamed}`)
  console.log('categories:', JSON.stringify(catCounts))
  console.log('status spread:', JSON.stringify(bands))
  if (!DRY) {
    const { data: sample } = await svc.from('products').select('sku, name, category').limit(6).order('sku')
    console.log('\nsample:')
    sample.forEach((s) => console.log(`  ${s.sku}  ${s.category.padEnd(18)} ${s.name}`))
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
