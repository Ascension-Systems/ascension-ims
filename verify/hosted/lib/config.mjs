/**
 * Hosted-path configuration.
 *
 * ------------------------------------------------------------------------------------
 * THE CONFIG PROOF PRINTS BOOLEANS AND NOTHING ELSE.
 * ------------------------------------------------------------------------------------
 * `set` / `unset`. Never a fragment, prefix, suffix, length, character count, hash,
 * checksum, first-n, last-n or masked form of any value. A length is a fingerprint and a
 * hash is a fingerprint. `scripts/check-no-secrets.sh` enforces mechanically that no line
 * in verify/ or scripts/ writes a `process.env.` value to stdout.
 *
 * The project ref IS printed, because it appears in the URL, is not a credential, and is
 * how a reader confirms the run is pointed at the intended project.
 *
 * NO SILENT FALLBACK. If any required variable is missing or empty, the runner prints
 * `NOT EXECUTED — no Supabase configuration` per affected attack and exits non-zero. It
 * never selects the embedded-Postgres path; that path is reachable only by name, via
 * `npm run verify:local`.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '..', '..', '..')

/** The three the application itself reads. All three are required by the hosted harness. */
export const REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]

/**
 * Harness-only, optional. Deliberately NOT in `.env.example`: that file is copied to
 * `.env.local` and consumed by the Next.js app, and the application never reads this name.
 * Pass it on the command line for the one run that needs it.
 */
export const OPTIONAL_VARS = ['PORTAL_BASE_URL']

/**
 * Minimal dotenv reader. ~20 lines on purpose.
 *
 *  - `KEY=VALUE` lines only; blank lines and `#` comments ignored.
 *  - DOES NOT override anything already present in process.env, so an explicit
 *    command-line value always wins.
 *  - Never logs, echoes or returns a value to any caller that prints.
 *
 * Rejected alternative: `node --env-file-if-exists=.env.local`. That flag landed in Node
 * 20.12 and package.json's `engines.node` floor is `>=20.9.0`, which is not in scope for
 * this pass. Do not raise `engines` to make the flag work.
 */
export function loadDotEnvLocal(root = REPO) {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== '') continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

const read = (name) => {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** Derives `rakslwwxduovcqnuercz` from `https://rakslwwxduovcqnuercz.supabase.co`. */
export function projectRefFromUrl(url) {
  if (!url) return null
  try {
    const host = new URL(url).hostname
    const first = host.split('.')[0]
    return first || null
  } catch {
    return null
  }
}

/**
 * Returns the resolved configuration plus a booleans-only presence map.
 * The caller may print `presence`; it may never print anything from `values`.
 */
export function loadConfig({ root = REPO } = {}) {
  loadDotEnvLocal(root)

  const values = {
    url: read('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: read('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceKey: read('SUPABASE_SERVICE_ROLE_KEY'),
    portalBaseUrl: read('PORTAL_BASE_URL'),
  }

  const presence = {
    NEXT_PUBLIC_SUPABASE_URL: values.url !== null,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: values.anonKey !== null,
    SUPABASE_SERVICE_ROLE_KEY: values.serviceKey !== null,
    PORTAL_BASE_URL: values.portalBaseUrl !== null,
  }

  const missing = REQUIRED_VARS.filter((name) => presence[name] === false)

  let urlValid = false
  if (values.url) {
    try {
      const u = new URL(values.url)
      urlValid = u.protocol === 'https:' || u.protocol === 'http:'
    } catch {
      urlValid = false
    }
  }

  return {
    ...values,
    presence,
    missing,
    urlValid,
    projectRef: projectRefFromUrl(values.url),
    ok: missing.length === 0 && urlValid,
    restUrl: values.url ? `${values.url.replace(/\/+$/, '')}/rest/v1` : null,
    authUrl: values.url ? `${values.url.replace(/\/+$/, '')}/auth/v1` : null,
  }
}

/**
 * The printed configuration block. Booleans only, in a fixed order, with the project ref.
 * Returns lines; the caller writes them. Nothing here interpolates a value.
 */
export function configProofLines(cfg) {
  const pad = (name) => `${name} ${'.'.repeat(Math.max(3, 34 - name.length))}`
  const state = (name) => (cfg.presence[name] ? 'set' : 'unset')
  const lines = ['CONFIGURATION']
  for (const name of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
    lines.push(`  ${pad(name)} ${state(name)}`)
  }
  lines.push(`  ${pad('project ref')} ${cfg.projectRef ?? '(unresolvable)'}`)
  if (cfg.presence.NEXT_PUBLIC_SUPABASE_URL && !cfg.urlValid) {
    lines.push('  NEXT_PUBLIC_SUPABASE_URL is set but is not a parseable http(s) URL.')
  }
  lines.push(
    '  (set / unset only. No value, fragment, length or hash of any variable is ever printed.)',
  )
  return lines
}

/**
 * The exact, non-negotiable wording for a run with no usable configuration.
 *
 * It is this string and nothing else — no suffix, no parenthetical, no variable names
 * inlined. Anything explanatory goes in the separate detail line below, so the verdict
 * itself stays greppable and identical everywhere it appears.
 */
export const NO_CONFIG = 'NOT EXECUTED — no Supabase configuration'

/** One line of context, printed alongside the verdict, never inside it. */
export function missingConfigDetail(cfg) {
  if (cfg.missing.length > 0) {
    return `not set: ${cfg.missing.join(', ')}. Copy .env.example to .env.local and fill it in from the Supabase dashboard (Project Settings -> API).`
  }
  return 'NEXT_PUBLIC_SUPABASE_URL is set but is not a parseable http(s) URL.'
}
