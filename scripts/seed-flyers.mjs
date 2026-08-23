// Seed the resources hub with PROFESSIONAL flyer/spec-sheet IMAGES (not the old blank PDFs).
// Renders branded PNGs (Ascension navy/cyan/cream, serif headlines) via sharp, uploads them to
// the private `documents` bucket, and inserts rows. Idempotent: clears existing docs first.
//
//   . ./.env.local && node scripts/seed-flyers.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const NAVY = '#0a2c4d', NAVY_DEEP = '#071a2c', CYAN = '#1db9e1', CREAM = '#fbfaf7', INK = '#1c1917', SOFT = '#57514b'
const W = 1000, H = 1300
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const serif = `Georgia, 'Times New Roman', serif`
const sans = `Helvetica, Arial, sans-serif`

// The Ascension triangle mark, as an inline SVG group at (x,y) scaled to `s` px.
const mark = (x, y, s) => `
  <g transform="translate(${x},${y})">
    <defs><linearGradient id="m${x}${y}" x1="0" y1="${s}" x2="${s}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1f2a8c"/><stop offset="0.55" stop-color="#1a5abd"/><stop offset="1" stop-color="${CYAN}"/>
    </linearGradient></defs>
    <path fill="url(#m${x}${y})" fill-rule="evenodd"
      d="M${s / 2} 0 L${s} ${s * 0.92} L0 ${s * 0.92} Z M${s / 2} ${s * 0.28} L${s * 0.78} ${s * 0.8} L${s * 0.22} ${s * 0.8} Z"/>
  </g>`

// Wrap a long string to <=n chars per line (word-safe), returns array of lines.
function wrap(str, n) {
  const words = str.split(' '); const lines = []; let cur = ''
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { lines.push(cur.trim()); cur = w } else cur += ' ' + w }
  if (cur.trim()) lines.push(cur.trim()); return lines
}

// No price column exists in the DB (products are stock-only), so these are plausible, DETERMINISTIC
// demo prices — realistic ranges by category, stable per product name.
const money = (n) => '$' + Math.round(n).toLocaleString('en-US')
function priceFor(name) {
  const n = name.toLowerCase()
  const base = /table|desk/.test(n) ? 1180 : /bookcase|storage|cabinet|credenza|shelv/.test(n) ? 880
    : /lamp|light|sconce/.test(n) ? 240 : /stool/.test(n) ? 320 : 520
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0)
  return base + (h % 9) * 45
}

function promoSVG({ eyebrow, title, priceWas, priceNow, save, body }) {
  const titleLines = wrap(title, 18)
  const ty = 460
  const baseY = ty + titleLines.length * 92
  const discount = priceWas != null
  const wasY = baseY + 46, nowY = baseY + 132, bodyY = baseY + 222
  const wasStr = discount ? money(priceWas) : ''
  const strikeW = Math.round(wasStr.length * 24)
  const priceBlock = discount
    ? `<text x="64" y="${wasY}" font-family="${serif}" font-size="44" fill="${SOFT}">${wasStr}</text>
       <line x1="60" y1="${wasY - 15}" x2="${64 + strikeW}" y2="${wasY - 15}" stroke="${SOFT}" stroke-width="4"/>
       <text x="64" y="${nowY}" font-family="${serif}" font-size="90" font-weight="700" fill="${NAVY}">${money(priceNow)}</text>
       <rect x="400" y="${nowY - 68}" width="240" height="80" rx="12" fill="${CYAN}"/>
       <text x="520" y="${nowY - 14}" text-anchor="middle" font-family="${sans}" font-size="34" font-weight="700" letter-spacing="1" fill="${NAVY_DEEP}">${xml(save)}</text>`
    : `<text x="64" y="${nowY - 24}" font-family="${sans}" font-size="26" letter-spacing="2" fill="${SOFT}">STARTING AT</text>
       <text x="64" y="${nowY + 48}" font-family="${serif}" font-size="86" font-weight="700" fill="${NAVY}">${money(priceNow)}</text>
       <rect x="470" y="${nowY - 18}" width="150" height="72" rx="12" fill="${CYAN}"/>
       <text x="545" y="${nowY + 30}" text-anchor="middle" font-family="${sans}" font-size="32" font-weight="700" fill="${NAVY_DEEP}">${xml(save)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${CREAM}"/>
    <path d="M${W} ${H} L${W} ${H - 340} L${W - 340} ${H} Z" fill="${CYAN}" opacity="0.10"/>
    <rect x="0" y="0" width="${W}" height="150" fill="${NAVY}"/>
    ${mark(56, 45, 62)}
    <text x="140" y="97" font-family="${serif}" font-size="40" font-weight="700" fill="#ffffff">Ascension IT</text>
    <text x="${W - 56}" y="94" text-anchor="end" font-family="${sans}" font-size="20" letter-spacing="3" fill="${CYAN}">PROMOTION</text>
    <text x="64" y="300" font-family="${sans}" font-size="26" font-weight="700" letter-spacing="6" fill="${CYAN}">${xml(eyebrow.toUpperCase())}</text>
    ${titleLines.map((l, i) => `<text x="60" y="${ty + i * 92}" font-family="${serif}" font-size="82" font-weight="700" fill="${NAVY}">${xml(l)}</text>`).join('')}
    ${priceBlock}
    ${wrap(body, 52).map((l, i) => `<text x="64" y="${bodyY + i * 44}" font-family="${sans}" font-size="30" fill="${SOFT}">${xml(l)}</text>`).join('')}
    <rect x="0" y="${H - 90}" width="${W}" height="90" fill="${NAVY_DEEP}"/>
    <text x="64" y="${H - 34}" font-family="${sans}" font-size="24" fill="#dfe8f0">Order through your Ascension IT rep · While stock lasts</text>
  </svg>`
}

function specSVG({ title, sku, specs }) {
  const titleLines = wrap(title, 24)
  const rowY = 470
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${CREAM}"/>
    <rect x="0" y="0" width="${W}" height="150" fill="${NAVY}"/>
    <text x="64" y="97" font-family="${serif}" font-size="40" font-weight="700" fill="#ffffff">Ascension IT</text>
    <text x="${W - 56}" y="94" text-anchor="end" font-family="${sans}" font-size="20" letter-spacing="3" fill="${CYAN}">SPEC SHEET</text>
    <text x="64" y="290" font-family="${sans}" font-size="24" font-weight="700" letter-spacing="4" fill="${CYAN}">${xml(sku)}</text>
    ${titleLines.map((l, i) => `<text x="60" y="${360 + i * 68}" font-family="${serif}" font-size="60" font-weight="700" fill="${NAVY}">${xml(l)}</text>`).join('')}
    ${specs.map((s, i) => {
      const y = rowY + titleLines.length * 68 + i * 92
      return `<line x1="64" y1="${y + 22}" x2="${W - 64}" y2="${y + 22}" stroke="#e8e3da" stroke-width="2"/>
        <text x="64" y="${y}" font-family="${sans}" font-size="24" letter-spacing="2" fill="${SOFT}">${xml(s.k.toUpperCase())}</text>
        <text x="${W - 64}" y="${y}" text-anchor="end" font-family="${serif}" font-size="34" font-weight="700" fill="${INK}">${xml(s.v)}</text>`
    }).join('')}
    <rect x="0" y="${H - 90}" width="${W}" height="90" fill="${NAVY_DEEP}"/>
    <text x="64" y="${H - 34}" font-family="${sans}" font-size="24" fill="#dfe8f0">Ascension IT · Full catalogue available from your rep</text>
  </svg>`
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer()

// Plausible specs by category keyword.
function specsFor(name) {
  const n = name.toLowerCase()
  const material = n.includes('lamp') ? 'Powder-coated steel' : n.includes('table') ? 'Solid oak veneer' : n.includes('bookcase') || n.includes('storage') ? 'Engineered wood' : 'Cast aluminium'
  return [
    { k: 'List price', v: money(priceFor(name)) },
    { k: 'Dimensions', v: n.includes('lamp') ? '18"W × 18"D × 58"H' : '72"W × 30"D × 29"H' },
    { k: 'Material', v: material },
    { k: 'Finish', v: 'Matte, commercial-grade' },
    { k: 'Weight', v: n.includes('lamp') ? '14 lb' : '86 lb' },
    { k: 'Warranty', v: '5-year commercial' },
  ]
}

async function main() {
  // Preview mode: render one of each to local files for visual review, no upload/DB writes.
  if (process.env.PREVIEW) {
    const dir = process.env.PREVIEW
    await sharp(Buffer.from(promoSVG({ eyebrow: 'Limited-time', title: 'Durango Summer Sale', priceWas: 899, priceNow: 719, save: '20% OFF', body: 'Every Durango cast-aluminium seating piece, reduced through the end of the season. Ask your rep to lock in pricing.' }))).png().toFile(`${dir}/preview-promo.png`)
    await sharp(Buffer.from(specSVG({ title: 'Ashgrove Laminate-Top Training Table', sku: 'SEA-9007', specs: specsFor('training table') }))).png().toFile(`${dir}/preview-spec.png`)
    console.log('previews written to', dir)
    return
  }

  await sb.storage.createBucket('documents', { public: false }).catch(() => {})
  const { data: products } = await sb.from('products').select('sku, name').in('category', ['Seating', 'Tables', 'Storage', 'Lighting']).limit(6)

  const { data: existing } = await sb.from('documents').select('id, storage_path')
  if (existing?.length) {
    await sb.storage.from('documents').remove(existing.map((d) => d.storage_path)).catch(() => {})
    await sb.from('documents').delete().in('id', existing.map((d) => d.id))
  }

  const rows = [
    { kind: 'promotion', title: 'Durango Collection — Summer Sale', description: '20% off all Durango cast-aluminum seating through the end of the season.',
      img: await png(promoSVG({ eyebrow: 'Limited-time', title: 'Durango Summer Sale', priceWas: 899, priceNow: 719, save: '20% OFF', body: 'Every Durango cast-aluminium seating piece, reduced through the end of the season. Ask your rep to lock in pricing.' })) },
    { kind: 'promotion', title: 'Ashgrove Lounge — Floor Model Clearance', description: 'Showroom lounge chairs reduced while stock lasts.',
      img: await png(promoSVG({ eyebrow: 'Clearance', title: 'Ashgrove Floor Models', priceWas: 1299, priceNow: 845, save: 'SAVE 35%', body: 'Showroom Ashgrove lounge chairs reduced to clear. One-of-a-kind pieces — first come, first served.' })) },
    { kind: 'promotion', title: 'New Arrival: Verity Executive Series', description: 'Just landed. Spec sheets in the library below.',
      img: await png(promoSVG({ eyebrow: 'New arrival', title: 'Verity Executive Series', priceNow: 1150, save: 'NEW', body: 'The Verity executive line has landed and is ready to order. Full spec sheets in the library below.' })) },
  ]

  // Spec sheets for the handful of products shown in the resources library (the "flyers menu").
  for (const p of (products ?? []).slice(0, 4)) {
    rows.push({
      kind: 'spec_sheet', title: `${p.name} — Spec Sheet`, description: null, product_sku: p.sku,
      img: await png(specSVG({ title: p.name, sku: p.sku, specs: specsFor(p.name) })),
    })
  }
  console.log(`generated ${rows.length} images (${Math.min(4, products?.length ?? 0)} spec sheets + 3 promos)`)

  // Upload + insert in small parallel batches — there are ~100 of these.
  let ok = 0
  const CHUNK = 8
  for (let i = 0; i < rows.length; i += CHUNK) {
    const results = await Promise.all(rows.slice(i, i + CHUNK).map(async (r) => {
      const path = `${r.kind}/${globalThis.crypto.randomUUID()}.png`
      const up = await sb.storage.from('documents').upload(path, r.img, { contentType: 'image/png' })
      if (up.error) { console.error('upload failed:', r.title, up.error.message); return false }
      const ins = await sb.from('documents').insert({
        kind: r.kind, title: r.title, description: r.description ?? null, product_sku: r.product_sku ?? null,
        storage_path: path, mime_type: 'image/png', size_bytes: r.img.length,
      })
      if (ins.error) { console.error('insert failed:', r.title, ins.error.message); await sb.storage.from('documents').remove([path]).catch(() => {}); return false }
      return true
    }))
    ok += results.filter(Boolean).length
  }
  console.log(`seeded ${ok}/${rows.length} flyer/spec images`)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
