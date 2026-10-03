#!/usr/bin/env node
/**
 * check:routes — every internal navigation target must resolve to a real route.
 *
 *   npm run check:routes
 *   npm run check:routes -- --self-test
 *
 * WHY THIS EXISTS: a link to a page that does not exist renders perfectly. Nothing errors at
 * build time, nothing errors on the server; the rep taps it and lands on a 404 with no way back.
 * That failure is invisible to typecheck, to lint, and to a passing build.
 *
 * IT MUST CATCH BOTH SPELLINGS. Targets in this codebase appear as JSX attributes
 * (`href="/inventory"`) AND as object properties (`href: '/inventory'`, in app-nav's PAGES
 * array). A check that only understood `href=` would report zero while the entire primary nav
 * went unchecked -- and zero-found is indistinguishable from never-looked. redirect() and
 * router.push() targets are navigation too, so they are checked on the same footing.
 *
 * SCOPE IS REPORTED, NOT ASSUMED: the run prints how many files it read and how many targets it
 * resolved. A number that suddenly drops is the signal that the check stopped reaching something.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const SELF_TEST = process.argv.includes('--self-test')

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '.git' || e === '.netlify') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Route table from the filesystem: page.tsx -> a page path, route.ts -> an API path. */
function buildRoutes() {
  const routes = []
  for (const f of walk(join(ROOT, 'app'))) {
    const rel = relative(join(ROOT, 'app'), f)
    if (!/(^|\/)(page|route)\.tsx?$/.test(rel)) continue
    let p = '/' + rel.replace(/(^|\/)(page|route)\.tsx?$/, '')
    p = p.replace(/\/+$/, '') || '/'
    // Route groups (folder) contribute nothing to the URL.
    p = p.replace(/\/\([^/]+\)/g, '') || '/'
    routes.push(p)
  }
  return [...new Set(routes)]
}

/** A dynamic segment matches any single non-empty segment; [...slug] matches the rest. */
const routeToRe = (r) =>
  new RegExp('^' + r
    .replace(/\[\.\.\.[^\]]+\]/g, '.+')
    .replace(/\[[^\]]+\]/g, '[^/]+')
    .replace(/\//g, '\\/') + '$')

function collectTargets(files) {
  const targets = []
  const patterns = [
    [/href\s*=\s*["']([^"']+)["']/g, 'href='],          // JSX attribute
    [/href\s*:\s*["']([^"']+)["']/g, 'href:'],          // object property  <- required by CLAUDE.md
    [/href\s*=\s*\{\s*`([^`]+)`\s*\}/g, 'href={`}'],    // template literal
    [/redirect\(\s*["']([^"']+)["']/g, 'redirect()'],
    // Any identifier, not just one spelled `router`: useRouter()'s return is frequently named
    // something else, and a pattern that insisted on `router.` would silently skip those.
    [/\b[A-Za-z_$][\w$]*\.(?:push|replace)\(\s*["'](\/[^"']*)["']/g, '.push()/.replace()'],
  ]
  for (const f of files) {
    if (!/\.(tsx?|jsx?|mjs)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const [re, kind] of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src))) {
        targets.push({ file: relative(ROOT, f), raw: m[1], kind,
          line: src.slice(0, m.index).split('\n').length })
      }
    }
  }
  return targets
}

function check() {
  const routes = buildRoutes()
  const res = routes.map((r) => ({ r, re: routeToRe(r) }))
  const files = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))
  const targets = collectTargets(files)

  const broken = []
  let resolved = 0
  const skipped = { external: 0, relative: 0 }
  for (const t of targets) {
    let path = t.raw
    // Every target is accounted for: resolved + broken + skipped must equal targetCount, so a
    // silently dropped category cannot masquerade as a clean result.
    if (/^(https?:|mailto:|tel:|#|data:)/.test(path)) { skipped.external++; continue }
    if (!path.startsWith('/')) { skipped.relative++; continue }
    path = path.split('?')[0].split('#')[0]
    // A template literal's ${...} becomes a wildcard segment.
    const probe = path.replace(/\$\{[^}]*\}/g, 'X').replace(/\/+$/, '') || '/'
    if (res.some(({ re }) => re.test(probe))) resolved++
    else broken.push({ ...t, probe })
  }

  return { routes, targetCount: targets.length, fileCount: files.length, resolved, broken, skipped }
}

// --- self test: plant a broken link of EACH supported form, prove each is caught -------------
if (SELF_TEST) {
  const dir = join(ROOT, 'components', '__routecheck_selftest__')
  mkdirSync(dir, { recursive: true })
  const forms = {
    'href=': `export const A = () => <a href="/definitely-not-a-route-a">x</a>`,
    'href:': `export const B = [{ href: '/definitely-not-a-route-b', label: 'x' }]`,
    'redirect()': `import {redirect} from 'next/navigation'; export const C = () => redirect('/definitely-not-a-route-c')`,
    '.push()': `import {useRouter} from 'next/navigation'; export const D = () => { const nav = useRouter(); nav.push('/definitely-not-a-route-d') }`,
  }
  let allCaught = true
  for (const [name, src] of Object.entries(forms)) {
    writeFileSync(join(dir, 'p.tsx'), src)
    const { broken } = check()
    const caught = broken.some((b) => b.raw.includes('definitely-not-a-route'))
    console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} planted broken link via ${name}`)
    if (!caught) allCaught = false
  }
  rmSync(dir, { recursive: true, force: true })
  const after = check()
  console.log(`  ${after.broken.length === 0 ? 'CLEAN  ' : 'DIRTY  '} after removing planted files`)
  console.log(allCaught && after.broken.length === 0
    ? '\nself-test PASSED — the check is live for every supported form'
    : '\nself-test FAILED — do not trust a zero from this check')
  process.exit(allCaught && after.broken.length === 0 ? 0 : 1)
}

const { routes, targetCount, fileCount, resolved, broken, skipped } = check()
const accounted = resolved + broken.length + skipped.external + skipped.relative
console.log(`check:routes — ${fileCount} files read, ${routes.length} routes known, ${targetCount} targets found`)
console.log(`  resolved ${resolved} | broken ${broken.length} | skipped ${skipped.external} external, ` +
            `${skipped.relative} relative | accounted ${accounted}/${targetCount}`)
if (accounted !== targetCount) {
  console.log('\nFAIL: internal accounting error — some targets were neither checked nor explained.')
  process.exit(1)
}
if (broken.length) {
  console.log('\nFAIL: navigation targets that resolve to nothing:\n')
  for (const b of broken) console.log(`  ${b.file}:${b.line}  [${b.kind}]  ${b.raw}`)
  console.log(`\n${broken.length} broken target(s).`)
  process.exit(1)
}
console.log('ok  : every internal navigation target resolves to a real route')
