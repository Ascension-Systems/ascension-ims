/**
 * Ingests Plantation Prestige's OWN published flyers into the resources library.
 *
 * plantationprestige.com/flyers hosts twelve finished marketing pieces as full-page artwork
 * (Marcella Cabana, Laguna Collection, the Logo Umbrella Program, and so on). Earlier passes
 * GENERATED look-alike flyers; comparing one against the real thing showed they were not close
 * — theirs are editorial, full-bleed lifestyle photography with a centred gold title and no
 * pricing, ours were promotional sell-sheets with brand bars and a price block.
 *
 * Rather than imitate a house style, this loads the real pieces. The library then shows exactly
 * what their reps already hand to customers, which is both a better demo and a truer product.
 *
 * PROVENANCE: their own artwork, shown back to them in their own demo. Confirm with them before
 * any wider use — flyer photography in this trade is often licensed from the manufacturer.
 *
 *   node scripts/ingest-plantation-flyers.mjs
 */
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

const FLYERS = [
  ['Marcella Cabana', 'marcella', 'Luxury pool and beach resort cabana, built for harsh coastal conditions.'],
  ['Laguna Collection', 'laguna-collection', 'The Laguna collection, for hospitality and multi-family projects.'],
  ['Poolside Finishes and Slings', 'poolside-finishes-and-slings', 'Finish and sling options rated for chlorine, salt and sun.'],
  ['Custom Acrylic Table Tops', 'custom-acrylic-table-tops', 'Acrylic tops cut to specification, in your finishes and edge profiles.'],
  ['Logo Umbrella Program', 'logo-umbrella-program', 'Custom-printed umbrellas carrying your property or brand mark.'],
  ['Ropes, Weaves and Wickers', 'ropes%2C-weaves-and-wickers', 'The rope, weave and wicker range across the collections.'],
  ['Faux Wood and Aluminum Frames', 'faux-wood-%26-aluminum-frames', 'Faux wood and aluminium frame options and finishes.'],
  ['Recracril Fabrics', 'recracril-fabrics', 'The Recracril fabric range, with colourways and specifications.'],
  ['DuraWood', 'durawood', 'The DuraWood range — recycled poly lumber for commercial settings.'],
  ['Sunbrella Deep Seating', 'sunbrella-deep-seating', 'Deep seating in solution-dyed Sunbrella acrylic.'],
  ['2025 NAFEM Flyer', '2025-nafem-flyer', 'The 2025 NAFEM show piece.'],
  ['NRA Flyer', 'nra-flyer', 'The NRA show piece.'],
]

const get = (url, opts = {}) =>
  fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(opts.timeout ?? 45_000) })

/** The flyer artwork is the largest content image on the page (Wix chrome uses the 11062b_ id). */
async function findArtwork(slug) {
  const html = await (await get(`https://www.plantationprestige.com/flyers/${slug}`)).text()
  const urls = [...new Set(html.match(/https:\/\/static\.wixstatic\.com\/media\/[A-Za-z0-9_~.%/,-]+?\.(?:jpg|png|jpeg)/g) || [])]
    .filter((u) => !u.includes('11062b_'))
  let best = null
  for (const u of urls.slice(0, 8)) {
    try {
      const r = await fetch(u, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      const len = Number(r.headers.get('content-length') || 0)
      if (r.ok && len > (best?.len ?? 0)) best = { u, len }
    } catch { /* skip */ }
  }
  return best && best.len > 150_000 ? best.u : null
}

async function main() {
  // Replace only the PROMOTION rows; the generated per-product spec sheets stay.
  const { data: old } = await sb.from('documents').select('id, storage_path').eq('kind', 'promotion')
  if (old?.length) {
    await sb.storage.from('documents').remove(old.map((d) => d.storage_path)).catch(() => {})
    await sb.from('documents').delete().in('id', old.map((d) => d.id))
    console.log(`removed ${old.length} generated promotions`)
  }

  let ok = 0
  for (const [title, slug, description] of FLYERS) {
    try {
      const art = await findArtwork(slug)
      if (!art) { console.log(`  skip  ${title} — no artwork found`); continue }
      const buf = Buffer.from(await (await get(art, { timeout: 90_000 })).arrayBuffer())
      // Their originals run to ~5 MB; a rep on a phone should not download that to view a flyer.
      const img = await sharp(buf).resize(1200, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 }).toBuffer()
      const path = `promotion/${globalThis.crypto.randomUUID()}.jpg`
      const up = await sb.storage.from('documents').upload(path, img, { contentType: 'image/jpeg' })
      if (up.error) throw new Error(up.error.message)
      const ins = await sb.from('documents').insert({
        kind: 'promotion', title, description, storage_path: path,
        mime_type: 'image/jpeg', size_bytes: img.length,
      })
      if (ins.error) { await sb.storage.from('documents').remove([path]).catch(() => {}); throw new Error(ins.error.message) }
      ok += 1
      console.log(`  ok    ${title}  (${(buf.length / 1e6).toFixed(1)}MB -> ${(img.length / 1e3).toFixed(0)}KB)`)
    } catch (e) {
      console.log(`  FAIL  ${title} — ${e.message}`)
    }
  }
  console.log(`\ningested ${ok}/${FLYERS.length} real Plantation Prestige flyers`)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
