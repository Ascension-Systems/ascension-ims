/**
 * Collects Plantation Prestige's real published catalogue — product name, product-page URL and
 * product photo — from their own public website, for use in the demo we are building FOR them.
 *
 * Source of truth is the schema.org `Product` block each product page publishes in an
 * `application/ld+json` script tag. That is structured data the site publishes for machines to
 * read, so this needs no HTML scraping heuristics and stays stable if they restyle the site.
 *
 * PROVENANCE NOTE. These are the client's own product names and photographs, taken from their
 * public site and shown back to them in their own demo. That is the narrow use this supports.
 * Before any wider or public use of the imagery, confirm with them — some product photography
 * in this industry is licensed from the manufacturer rather than owned by the dealer.
 *
 * Polite by construction: modest concurrency, a real UA, and it stops at the number requested
 * rather than crawling all 300+ pages.
 *
 *   node scripts/scrape-plantation-catalogue.mjs [count]     -> writes scripts/pp-catalogue.json
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const WANT = Number(process.argv[2] ?? 110)
const CONCURRENCY = 6
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const SITEMAP = 'https://www.plantationprestige.com/store-products-sitemap.xml'

/**
 * Normalise a product name for display in our UI.
 *
 * Two classes of problem, both real in the source data:
 *   1. HTML ENTITIES. The JSON-LD carries `&quot;` for inch marks (96 of ~290 names), and
 *      JSON.parse does not decode HTML entities — so 'Bali Dining Table 36&quot; Square'
 *      would render literally. Decoded here rather than in the UI, so the stored value is
 *      already correct wherever it is read.
 *   2. TYPOS in the published catalogue ("Barstoool", "Bartsool") and stray double spaces.
 *      We correct these on our side rather than mirror them — a demo that reproduces a
 *      client's typos reads as our sloppiness, not theirs.
 */
const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }
const TYPOS = [
  [/\bbarstoool\b/gi, 'Barstool'],
  [/\bbartsool\b/gi, 'Barstool'],
  [/\bstoool\b/gi, 'Stool'],
]
export function cleanName(raw) {
  let s = String(raw)
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  s = s.replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
  for (const [re, to] of TYPOS) s = s.replace(re, to)
  return s.replace(/\s+/g, ' ').trim()
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** Pull the schema.org Product object out of a product page. */
function parseProduct(html, url) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1])
  for (const b of blocks) {
    let d
    try {
      d = JSON.parse(b)
    } catch {
      continue
    }
    const candidates = Array.isArray(d) ? d : [d]
    for (const c of candidates) {
      if (c && c['@type'] === 'Product' && c.name) {
        // schema.org `image` may be a URL string, an ImageObject, or an array of either.
        // Stringifying an ImageObject yields "[object Object]", so unwrap it explicitly.
        const raw = Array.isArray(c.image) ? c.image[0] : c.image
        const image =
          typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw.url ?? raw.contentUrl ?? null) : null
        return { name: cleanName(c.name), url, image: image ? String(image) : null }
      }
    }
  }
  return null
}

async function main() {
  console.log('fetching sitemap…')
  const xml = await get(SITEMAP)
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.includes('/product-page/'))
  console.log(`sitemap lists ${urls.length} product pages; fetching ${Math.min(WANT, urls.length)}`)

  const targets = urls.slice(0, WANT)
  const out = []
  let i = 0
  let failed = 0

  const worker = async () => {
    while (i < targets.length) {
      const url = targets[i++]
      try {
        const p = parseProduct(await get(url), url)
        if (p && p.image) {
          out.push(p)
          if (out.length % 20 === 0) console.log(`  ${out.length} collected…`)
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Stable order so downstream mapping is deterministic across runs.
  out.sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync('scripts/pp-catalogue.json', JSON.stringify(out, null, 2))
  console.log(`\ncollected ${out.length} products (${failed} skipped) -> scripts/pp-catalogue.json`)
  out.slice(0, 8).forEach((p) => console.log(`  - ${p.name}`))
}

// Only crawl when run directly. apply-real-catalogue.mjs imports cleanName() from here, and
// importing a module must not kick off a 300-page scrape as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('ERROR:', e.message)
    process.exit(1)
  })
}
