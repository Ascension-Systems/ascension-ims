/**
 * Regenerates the resources library — promotions and spec sheets — as PLANTATION PRESTIGE
 * material, using their real published products and their real product photography.
 *
 * Supersedes scripts/seed-flyers.mjs, which rendered Ascension IT branding over invented
 * product names. Three things change:
 *   1. Brand: Ascension navy/cyan -> Plantation Prestige brown/honey over cream.
 *   2. Copy: invented collections -> their actual collections (Geneva, Montego, Adirondack…),
 *      read from scripts/pp-catalogue.json (see scrape-plantation-catalogue.mjs).
 *   3. Imagery: each flyer now carries the ACTUAL product photograph, composited into the
 *      layout, instead of being type-only. A flyer with the product on it is the thing a rep
 *      actually sends a customer.
 *
 * Run scripts/scrape-plantation-catalogue.mjs first to produce pp-catalogue.json.
 *
 *   node scripts/seed-plantation-resources.mjs
 *   PREVIEW=/tmp/x node scripts/seed-plantation-resources.mjs   (render locally, no uploads)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { cleanName } from './scrape-plantation-catalogue.mjs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/* ---------------- Plantation Prestige brand ---------------- */
const BROWN = '#5c3d24', BROWN_DEEP = '#3e2817', HONEY = '#c89a5b', CREAM = '#faf6ee'
const INK = '#1c1917', SOFT = '#4a443e'
const W = 1000, H = 1300
const PHOTO_TOP = 150, PHOTO_H = 520
// SINGLE quotes inside these stacks, not double. They are interpolated into double-quoted SVG
// attributes, so an inner double quote closes the attribute early and the document fails to
// parse ("Opening and ending tag mismatch: svg line 1 and text").
const serif = "Georgia, 'Iowan Old Style', serif"
const sans = "'Helvetica Neue', Helvetica, Arial, sans-serif"

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const money = (n) => `$${n.toLocaleString('en-US')}`

/** Deterministic list price from the product name, so a flyer and its spec sheet agree. */
function priceFor(name) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const n = name.toLowerCase()
  const base = n.includes('umbrella') || n.includes('cantilever') ? 700
    : n.includes('table') ? 850
    : n.includes('chaise') || n.includes('lounge') ? 900
    : n.includes('cushion') || n.includes('sling') ? 120
    : n.includes('base') ? 220
    : 480
  return base + (h % 12) * 25
}

/** Wrap a title into lines of at most `max` characters, on word boundaries. */
function wrap(text, max) {
  const words = String(text).split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur.trim()); cur = w } else { cur = (cur + ' ' + w).trim() }
  }
  if (cur) lines.push(cur)
  return lines
}

function promoSVG({ eyebrow, title, priceWas, priceNow, save, body }) {
  const titleLines = wrap(title, 20).slice(0, 2)
  const bodyLines = wrap(body, 52).slice(0, 4)
  // Title baseline sits clear of the eyebrow above it: at 70px the cap height reaches ~50px
  // above the baseline, which collided with the eyebrow when this was +96.
  const ty = PHOTO_TOP + PHOTO_H + 140
  const priceY = ty + titleLines.length * 78 + 96
  const priceBlock = priceWas
    ? `<text x="64" y="${priceY - 52}" font-family="${sans}" font-size="34" fill="${SOFT}" text-decoration="line-through">${money(priceWas)}</text>
       <text x="64" y="${priceY + 34}" font-family="${serif}" font-size="86" font-weight="700" fill="${BROWN}">${money(priceNow)}</text>
       <rect x="430" y="${priceY - 34}" width="250" height="82" rx="14" fill="${HONEY}"/>
       <text x="555" y="${priceY + 22}" text-anchor="middle" font-family="${sans}" font-size="34" font-weight="700" letter-spacing="1" fill="${BROWN_DEEP}">${xml(save)}</text>`
    : `<text x="64" y="${priceY - 6}" font-family="${sans}" font-size="26" letter-spacing="3" fill="${SOFT}">STARTING AT</text>
       <text x="64" y="${priceY + 74}" font-family="${serif}" font-size="86" font-weight="700" fill="${BROWN}">${money(priceNow)}</text>
       <rect x="430" y="${priceY + 6}" width="170" height="76" rx="14" fill="${HONEY}"/>
       <text x="515" y="${priceY + 58}" text-anchor="middle" font-family="${sans}" font-size="32" font-weight="700" fill="${BROWN_DEEP}">${xml(save)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${CREAM}"/>
    <rect x="0" y="0" width="${W}" height="${PHOTO_TOP}" fill="${BROWN}"/>
    <text x="64" y="97" font-family="${serif}" font-size="42" font-weight="700" fill="#ffffff">Plantation Prestige</text>
    <text x="${W - 56}" y="94" text-anchor="end" font-family="${sans}" font-size="20" letter-spacing="3" fill="${HONEY}">PROMOTION</text>
    <text x="64" y="${PHOTO_TOP + PHOTO_H + 52}" font-family="${sans}" font-size="26" font-weight="700" letter-spacing="6" fill="${HONEY}">${xml(eyebrow.toUpperCase())}</text>
    ${titleLines.map((l, i) => `<text x="60" y="${ty + i * 78}" font-family="${serif}" font-size="70" font-weight="700" fill="${BROWN}">${xml(l)}</text>`).join('')}
    ${priceBlock}
    ${bodyLines.map((l, i) => `<text x="64" y="${priceY + 130 + i * 36}" font-family="${sans}" font-size="26" fill="${SOFT}">${xml(l)}</text>`).join('')}
    <rect x="0" y="${H - 90}" width="${W}" height="90" fill="${BROWN_DEEP}"/>
    <text x="64" y="${H - 34}" font-family="${sans}" font-size="24" fill="#e8dccd">Order through your Plantation Prestige rep · While stock lasts</text>
  </svg>`
}

function specSVG({ title, sku, specs }) {
  const titleLines = wrap(title, 26).slice(0, 2)
  const top = PHOTO_TOP + PHOTO_H + 60
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${CREAM}"/>
    <rect x="0" y="0" width="${W}" height="${PHOTO_TOP}" fill="${BROWN}"/>
    <text x="64" y="97" font-family="${serif}" font-size="42" font-weight="700" fill="#ffffff">Plantation Prestige</text>
    <text x="${W - 56}" y="94" text-anchor="end" font-family="${sans}" font-size="20" letter-spacing="3" fill="${HONEY}">SPEC SHEET</text>
    <text x="64" y="${top}" font-family="${sans}" font-size="24" font-weight="700" letter-spacing="4" fill="${HONEY}">${xml(sku)}</text>
    ${titleLines.map((l, i) => `<text x="60" y="${top + 62 + i * 56}" font-family="${serif}" font-size="52" font-weight="700" fill="${BROWN}">${xml(l)}</text>`).join('')}
    ${specs.map((s, i) => {
      // Row pitch and start are sized so all six rows clear the 90px footer bar at the bottom;
      // at the previous 54px pitch the last row (Warranty) rendered behind it.
      const y = top + 62 + titleLines.length * 56 + 34 + i * 46
      return `<line x1="64" y1="${y + 14}" x2="${W - 64}" y2="${y + 14}" stroke="#e0d5c4" stroke-width="1"/>
              <text x="64" y="${y}" font-family="${sans}" font-size="26" fill="${SOFT}">${xml(s.k)}</text>
              <text x="${W - 64}" y="${y}" text-anchor="end" font-family="${sans}" font-size="26" font-weight="700" fill="${INK}">${xml(s.v)}</text>`
    }).join('')}
    <rect x="0" y="${H - 90}" width="${W}" height="90" fill="${BROWN_DEEP}"/>
    <text x="64" y="${H - 34}" font-family="${sans}" font-size="24" fill="#e8dccd">Plantation Prestige · Full catalogue available from your rep</text>
  </svg>`
}

function specsFor(name) {
  const n = name.toLowerCase()
  const isUmbrella = n.includes('umbrella') || n.includes('cantilever')
  const isCushion = n.includes('cushion') || n.includes('sling')
  return [
    { k: 'List price', v: money(priceFor(name)) },
    { k: 'Dimensions', v: isUmbrella ? '11′ span × 8′ 6″ H' : isCushion ? '24"W × 22"D × 4"H' : '48"W × 26"D × 34"H' },
    { k: 'Frame', v: isUmbrella ? 'Powder-coated aluminium' : isCushion ? 'n/a' : 'Cast aluminium' },
    { k: 'Fabric', v: isCushion || isUmbrella ? 'Solution-dyed acrylic' : 'Textilene sling' },
    { k: 'Finish', v: 'Commercial-grade, UV stable' },
    { k: 'Warranty', v: '5-year commercial' },
  ]
}

/* ---------------- product photos ---------------- */
const CACHE = join('scripts', '.pp-images')
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

async function photoFor(item) {
  const key = join(CACHE, `${Buffer.from(item.url).toString('base64url').slice(0, 40)}.bin`)
  if (existsSync(key)) return readFileSync(key)
  const res = await fetch(item.image, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`photo HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(key, buf)
  return buf
}

/** Render the chrome, then composite the real product photo into its band. */
async function render(svg, photoBuf) {
  const base = sharp(Buffer.from(svg)).png()
  if (!photoBuf) return base.toBuffer()
  const photo = await sharp(photoBuf).resize(W, PHOTO_H, { fit: 'cover', position: 'centre' }).png().toBuffer()
  return base.composite([{ input: photo, top: PHOTO_TOP, left: 0 }]).png().toBuffer()
}

async function main() {
  const catalogue = JSON.parse(readFileSync('scripts/pp-catalogue.json', 'utf8'))
  const byName = (kw) => catalogue.filter((c) => c.name.toLowerCase().includes(kw))

  // Promotions built around products that actually exist in their catalogue, so the photo,
  // the collection name and the copy all agree.
  const geneva = byName('geneva')[0] ?? catalogue[0]
  const montego = byName('montego')[0] ?? catalogue[1]
  const adirondack = byName('adirondack')[0] ?? catalogue[2]

  const promos = [
    {
      title: `${geneva.name.replace(/^[\d.'" ]*/, '').split(' ').slice(0, 2).join(' ')} Collection — Summer Sale`,
      description: 'Seasonal pricing on the Geneva shade collection through the end of summer.',
      item: geneva,
      svg: promoSVG({
        eyebrow: 'Limited-time', title: 'Geneva Summer Sale',
        priceWas: priceFor(geneva.name), priceNow: Math.round(priceFor(geneva.name) * 0.8), save: '20% OFF',
        body: 'Every Geneva umbrella reduced through the end of the season. Ask your rep to lock in pricing for your property.',
      }),
    },
    {
      title: 'Montego Umbrellas — Floor Model Clearance',
      description: 'Showroom Montego umbrellas reduced while stock lasts.',
      item: montego,
      svg: promoSVG({
        eyebrow: 'Clearance', title: 'Montego Clearance',
        priceWas: priceFor(montego.name), priceNow: Math.round(priceFor(montego.name) * 0.65), save: 'SAVE 35%',
        body: 'Showroom Montego umbrellas reduced to clear. One-of-a-kind pieces — first come, first served.',
      }),
    },
    {
      title: `New Arrival: ${adirondack.name}`,
      description: 'Just landed. Spec sheets in the library below.',
      item: adirondack,
      svg: promoSVG({
        eyebrow: 'New arrival', title: adirondack.name,
        priceNow: priceFor(adirondack.name), save: 'NEW',
        body: 'Just landed and ready to order for the season. Full specifications in the library below.',
      }),
    },
  ]

  if (process.env.PREVIEW) {
    const dir = process.env.PREVIEW
    writeFileSync(join(dir, 'preview-promo.png'), await render(promos[0].svg, await photoFor(promos[0].item)))
    const s = catalogue[5]
    writeFileSync(join(dir, 'preview-spec.png'), await render(specSVG({ title: s.name, sku: 'SEA-1184', specs: specsFor(s.name) }), await photoFor(s)))
    console.log('previews written to', dir)
    return
  }

  // Spec sheets for products that exist in OUR inventory, matched to a real photo by position.
  const { data: products } = await sb
    .from('products')
    .select('sku, name')
    .in('category', ['Umbrellas', 'Seating', 'Tables', 'Loungers'])
    .limit(6)

  const rows = []
  for (const p of promos) {
    rows.push({ kind: 'promotion', title: p.title, description: p.description, img: await render(p.svg, await photoFor(p.item)) })
  }
  // Match each sheet's photo to the product it is ABOUT. Products now carry their real
  // published names, so an exact name lookup pairs the right photograph with the right
  // title — previously the photo was taken by position and showed a different product.
  const byName = new Map(catalogue.map((c) => [cleanName(c.name).toLowerCase(), c]))
  let n = 10
  for (const p of (products ?? []).slice(0, 4)) {
    const item = byName.get(String(p.name).toLowerCase()) ?? catalogue[n++ % catalogue.length]
    rows.push({
      kind: 'spec_sheet', title: p.name, description: null, product_sku: p.sku,
      img: await render(specSVG({ title: p.name, sku: p.sku, specs: specsFor(p.name) }), await photoFor(item)),
    })
  }

  // Replace the previous library wholesale — the old files carry the wrong brand entirely.
  const { data: existing } = await sb.from('documents').select('id, storage_path')
  if (existing?.length) {
    await sb.storage.from('documents').remove(existing.map((d) => d.storage_path)).catch(() => {})
    await sb.from('documents').delete().in('id', existing.map((d) => d.id))
    console.log(`removed ${existing.length} old documents`)
  }

  let ok = 0
  for (const r of rows) {
    const path = `${r.kind}/${globalThis.crypto.randomUUID()}.png`
    const up = await sb.storage.from('documents').upload(path, r.img, { contentType: 'image/png' })
    if (up.error) { console.error('upload failed:', r.title, up.error.message); continue }
    const ins = await sb.from('documents').insert({
      kind: r.kind, title: r.title, description: r.description ?? null, product_sku: r.product_sku ?? null,
      storage_path: path, mime_type: 'image/png', size_bytes: r.img.length,
    })
    if (ins.error) { console.error('insert failed:', r.title, ins.error.message); await sb.storage.from('documents').remove([path]).catch(() => {}); continue }
    ok += 1
  }
  console.log(`seeded ${ok}/${rows.length} Plantation Prestige resources (${promos.length} promotions + ${rows.length - promos.length} spec sheets)`)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
