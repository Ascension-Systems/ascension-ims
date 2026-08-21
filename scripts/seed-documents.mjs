// Seed the resources hub with demo promotions + spec sheets.
//
// Generates small but VALID PDFs (title + subtitle on one page), uploads them to the private
// `documents` bucket via the service role, and inserts the matching rows. Idempotent: it clears
// existing rows + objects first, so re-running gives a clean set.
//
// Requires migration 0015 applied (the `documents` table + bucket + RLS). Run from the project
// root:  . ./.env.local && node scripts/seed-documents.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const esc = (s) => s.replace(/([()\\])/g, '\\$1')
function pdf(title, subtitle) {
  const content = `BT /F1 28 Tf 64 700 Td (${esc(title)}) Tj ET BT /F1 15 Tf 64 664 Td (${esc(subtitle)}) Tj ET`
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xrefStart = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((off) => {
    out += String(off).padStart(10, '0') + ' 00000 n \n'
  })
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

async function main() {
  // Ensure the bucket exists (idempotent) even if only the table half of 0015 was applied.
  await sb.storage.createBucket('documents', { public: false }).catch(() => {})

  // A few real SKUs so spec sheets link to actual products.
  const { data: products, error: pe } = await sb
    .from('products')
    .select('sku, name')
    .in('category', ['Seating', 'Tables', 'Storage'])
    .limit(6)
  if (pe) {
    console.error('Could not read products — is 0015 applied and the DB reachable?', pe.message)
    process.exit(1)
  }

  // Clear existing demo docs (rows + objects) for a clean re-seed.
  const { data: existing } = await sb.from('documents').select('id, storage_path')
  if (existing?.length) {
    await sb.storage.from('documents').remove(existing.map((d) => d.storage_path)).catch(() => {})
    await sb.from('documents').delete().in('id', existing.map((d) => d.id))
  }

  const rows = [
    { kind: 'promotion', title: 'Durango Collection — Summer Sale', description: '20% off all Durango cast-aluminum seating through the end of the season.', file: pdf('DURANGO SUMMER SALE', '20% off Durango seating - limited time') },
    { kind: 'promotion', title: 'Ashgrove Lounge — Floor Model Clearance', description: 'Showroom lounge chairs reduced while stock lasts.', file: pdf('ASHGROVE CLEARANCE', 'Floor models reduced - while stock lasts') },
    { kind: 'promotion', title: 'New Arrival: Verity Executive Series', description: 'Just landed. Spec sheets in the library below.', file: pdf('VERITY EXECUTIVE SERIES', 'New arrival - now available to order') },
  ]

  const kinds = ['spec_sheet', 'spec_sheet', 'flyer', 'price_sheet']
  ;(products ?? []).slice(0, 4).forEach((p, i) => {
    rows.push({
      kind: kinds[i] ?? 'spec_sheet',
      title: `${p.name} — ${kinds[i] === 'price_sheet' ? 'Price Sheet' : kinds[i] === 'flyer' ? 'Flyer' : 'Spec Sheet'}`,
      description: null,
      product_sku: p.sku,
      file: pdf(p.name, `${p.sku} - specifications`),
    })
  })

  let ok = 0
  for (const r of rows) {
    const path = `${r.kind}/${globalThis.crypto.randomUUID()}.pdf`
    const up = await sb.storage.from('documents').upload(path, r.file, { contentType: 'application/pdf' })
    if (up.error) {
      console.error('upload failed:', r.title, up.error.message)
      continue
    }
    const ins = await sb.from('documents').insert({
      kind: r.kind,
      title: r.title,
      description: r.description ?? null,
      product_sku: r.product_sku ?? null,
      storage_path: path,
      mime_type: 'application/pdf',
      size_bytes: r.file.length,
    })
    if (ins.error) {
      console.error('insert failed:', r.title, ins.error.message)
      await sb.storage.from('documents').remove([path]).catch(() => {})
      continue
    }
    ok++
  }
  console.log(`seeded ${ok}/${rows.length} documents`)
}

main()
