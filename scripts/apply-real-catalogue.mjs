/**
 * Replaces the demo catalogue's invented product names with Plantation Prestige's REAL published
 * products — name, product-page URL and product photograph — from scripts/pp-catalogue.json.
 *
 * Assignment keeps SKU prefixes coherent: a SEA- sku gets a real seating product, STO- gets a
 * real umbrella, and so on, using the same prefix->category map the re-skin script uses. So the
 * catalogue reads correctly whichever column a rep sorts or filters by.
 *
 * DEGRADES GRACEFULLY. product_url and image_path arrive in migration 0023; if that has not been
 * applied yet this still writes names and categories and reports the columns as pending, so the
 * catalogue is never left half-converted while waiting on a migration.
 *
 *   node scripts/apply-real-catalogue.mjs [--dry-run]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
// Cleaning lives with the scraper, but is re-applied here so an existing pp-catalogue.json
// written before the fix is still corrected without needing a re-scrape.
import { cleanName } from './scrape-plantation-catalogue.mjs'

const DRY = process.argv.includes('--dry-run')
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PREFIX_TO_CATEGORY = {
  SEA: 'Seating', TAB: 'Tables', STO: 'Umbrellas',
  WRK: 'Loungers', LGT: 'Cushions & Slings', ACC: 'Accessories',
}

/** Derive our category from the client's own product name. */
function categoryOf(name) {
  const n = name.toLowerCase()
  if (/umbrella|cantilever/.test(n)) return 'Umbrellas'
  if (/chaise|lounger|daybed|sun lounge/.test(n)) return 'Loungers'
  if (/cushion|sling|pillow/.test(n)) return 'Cushions & Slings'
  if (/table|top\b/.test(n)) return 'Tables'
  if (/chair|stool|sofa|loveseat|bench|ottoman|glider|rocker|settee|section|seat/.test(n)) return 'Seating'
  if (/base|cover|cart|planter|urn|valet|tray|screen|hook|weight/.test(n)) return 'Accessories'
  return 'Accessories'
}

const CACHE = join('scripts', '.pp-images')
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

async function photoBytes(item) {
  const key = join(CACHE, `${Buffer.from(item.url).toString('base64url').slice(0, 40)}.bin`)
  let buf
  if (existsSync(key)) buf = readFileSync(key)
  else {
    const res = await fetch(item.image, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(key, buf)
  }
  // Normalise to a modest square JPEG: consistent in the list, and small enough that a rep on a
  // phone in a car park is not downloading a 1 MB hero image per row.
  return sharp(buf).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
}

async function main() {
  const catalogue = JSON.parse(readFileSync('scripts/pp-catalogue.json', 'utf8'))
    .filter((c) => typeof c.image === 'string' && c.image.startsWith('http'))

  // Does migration 0023 exist yet?
  const probe = await svc.from('products').select('sku, image_path, product_url').limit(1)
  const hasNewColumns = !probe.error
  if (!hasNewColumns) console.log('NOTE: migration 0023 not applied — writing names/categories only.\n')

  const pools = {}
  for (const c of catalogue) (pools[categoryOf(cleanName(c.name))] ??= []).push(c)
  console.log('real products available per category:',
    JSON.stringify(Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]))))

  const { data: products, error } = await svc.from('products').select('sku').order('sku')
  if (error) throw new Error(error.message)

  const cursor = {}
  const spare = [...catalogue]
  let spareAt = 0
  let named = 0, withPhoto = 0
  const used = new Set()

  for (const p of products) {
    const target = PREFIX_TO_CATEGORY[p.sku.slice(0, 3)] ?? 'Accessories'
    const pool = pools[target] ?? []
    cursor[target] ??= 0
    let item = pool[cursor[target]++]
    // Pool exhausted for this category — fall back to any unused product rather than repeat one.
    while ((!item || used.has(item.url)) && spareAt < spare.length) item = spare[spareAt++]
    if (!item) continue
    used.add(item.url)

    const display = cleanName(item.name)
    const patch = { name: display, category: categoryOf(display) }

    if (hasNewColumns && !DRY) {
      patch.product_url = item.url
      try {
        const bytes = await photoBytes(item)
        const path = `${p.sku}.jpg`
        const up = await svc.storage.from('product-images').upload(path, bytes, {
          contentType: 'image/jpeg', upsert: true,
        })
        if (up.error) throw new Error(up.error.message)
        patch.image_path = path
        withPhoto += 1
      } catch (e) {
        console.error(`  photo failed for ${p.sku}: ${e.message}`)
      }
    }

    if (!DRY) {
      const { error: ue } = await svc.from('products').update(patch).eq('sku', p.sku)
      if (ue) { console.error(`  update ${p.sku}: ${ue.message}`); continue }
    }
    named += 1
    if (named % 20 === 0) console.log(`  ${named} products updated…`)
  }

  console.log(`\n${DRY ? 'WOULD UPDATE' : 'updated'} ${named} products; ${withPhoto} with photos`)
  if (!DRY) {
    const { data: sample } = await svc.from('products').select('sku, name, category').order('sku').limit(8)
    sample.forEach((s) => console.log(`  ${s.sku}  ${s.category.padEnd(18)} ${s.name}`))
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
