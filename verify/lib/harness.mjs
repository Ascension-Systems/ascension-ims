/**
 * Verification harness — shared plumbing for `npm run verify:local` ONLY.
 *
 * ASSERTIONS ARE MADE AGAINST A REAL DATABASE, NEVER AGAINST MOCKS. A mocked RLS policy
 * proves nothing; that is the whole point of the four attacks.
 *
 * ------------------------------------------------------------------------------------
 * SCOPE: POLICY LOGIC ONLY. THIS FILE IS NOT ON THE HOSTED PATH.
 * ------------------------------------------------------------------------------------
 * Nothing in this file connects to the hosted Supabase project, and nothing in
 * `verify/hosted/**` may import from it. `bootstrap()` below begins with
 * `DROP SCHEMA IF EXISTS public CASCADE` — one careless import is all that stands between
 * that statement and a client's production database, so `bootstrap()` carries a hard
 * loopback-only guard that throws before it issues a single query.
 *
 * TWO WAYS TO GET A LOCAL DATABASE. run-all-local.mjs prints which one was used.
 *
 *  PATH B  — plain psql/pg against a local Postgres you already run.
 *            Selected when VERIFY_DATABASE_URL is set. Applies verify/shim/00_auth_shim.sql
 *            first, which supplies the minimum auth surface the migrations reference.
 *            The URL must resolve to a loopback host; bootstrap() refuses otherwise.
 *
 *  PATH B′ — an ephemeral Postgres started by this harness (`embedded-postgres`), used when
 *            VERIFY_DATABASE_URL is absent. Same shim, same migrations, a real PostgreSQL
 *            server process on a loopback port, torn down at the end. Its superuser password
 *            is generated at runtime with crypto.randomBytes and is never written to disk or
 *            to the repo.
 *
 * There is deliberately NO Supabase-CLI / docker detection branch. There is no supabase CLI
 * in this environment, and a detection branch that can never fire is how a future reader
 * concludes the option exists.
 *
 * HONEST LIMITATION, stated rather than papered over: this path asserts its own identity by
 * setting the request.jwt.claims GUC directly. It proves the POLICIES are correct given an
 * identity. It does NOT cover identity issuance, JWT signing, JWT verification, PostgREST
 * request handling, or session handling — see PATH_CAVEAT at the foot of this file.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { parse as parseConnectionString } from 'pg-connection-string'
import { Report } from './report.mjs'

// Re-exported so the four attack files keep importing Report from here, unchanged.
export { Report }

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '..', '..')
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations')
const SEED_DIR = join(REPO, 'supabase', 'seed')
const SHIM = join(REPO, 'verify', 'shim', '00_auth_shim.sql')
const SETUP = join(REPO, 'verify', '00-setup.sql')

export const REP_UID = '00000000-0000-4000-8000-000000000001'
export const ADMIN_UID = '00000000-0000-4000-8000-000000000002'

/* ==================================================================== *
 * Path selection
 * ==================================================================== */

let embedded = null
let embeddedDir = null

/**
 * Hosts this harness is permitted to reset and rewrite. Anything else is refused.
 * `bootstrap()` drops and recreates the `public` schema; there is no safe way to do that to
 * a database that is not a disposable local one.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

const isLoopbackHost = (host) => {
  if (typeof host !== 'string' || host.length === 0) return false
  const bare = host.replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(bare) || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

/**
 * Judged on what `pg` will ACTUALLY connect to, not on the URL's authority. pg parses the
 * string with pg-connection-string, where a `?host=` query parameter overrides the hostname:
 * `postgresql://u:p@localhost/db?host=remote` connects to `remote`. Checking
 * `new URL(...).hostname` alone was therefore bypassable. So: postgres schemes only, no
 * host-redirecting query parameters at all, and the effective parsed host must be loopback.
 * bootstrap() additionally confirms the live server address before issuing destructive SQL.
 */
export function isLoopbackDbUrl(dbUrl) {
  if (typeof dbUrl !== 'string' || dbUrl.length === 0) return false
  let url
  try {
    url = new URL(dbUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false
  for (const key of url.searchParams.keys()) {
    if (['host', 'hostaddr', 'socket', 'service'].includes(key.toLowerCase())) return false
  }
  if (!isLoopbackHost(url.hostname)) return false
  let parsed
  try {
    parsed = parseConnectionString(dbUrl)
  } catch {
    return false
  }
  return isLoopbackHost(parsed.host)
}

/** inet_server_addr() of the live connection: loopback TCP only (NULL = unix socket, refused). */
async function assertConnectedToLoopback(client) {
  const { rows } = await client.query('SELECT host(inet_server_addr()) AS addr')
  const addr = rows[0]?.addr ?? null
  if (!isLoopbackHost(addr)) {
    throw new Error(
      `REFUSING TO BOOTSTRAP: the live connection's server address is ${addr ?? 'NULL (unix socket)'}, ` +
        'not a loopback TCP address. Nothing was dropped.',
    )
  }
}

/**
 * Resolves a live local Postgres and returns { path, label, dbUrl, usesShim }.
 * `path` is 'B' | 'B-embedded'.
 */
export async function resolveDatabase() {
  if (process.env.VERIFY_DATABASE_URL) {
    return {
      path: 'B',
      label: 'B (plain psql against a local Postgres, via VERIFY_DATABASE_URL)',
      dbUrl: process.env.VERIFY_DATABASE_URL,
      usesShim: true,
    }
  }

  // Path B' — start a real, ephemeral PostgreSQL server on loopback.
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  embeddedDir = mkdtempSync(join(tmpdir(), 'inventory-portal-verify-'))
  const port = 5000 + Math.floor(Math.random() * 3000)
  // Generated at runtime. Never written to the repo, never logged, never persisted.
  const password = randomBytes(24).toString('hex')

  embedded = new EmbeddedPostgres({
    databaseDir: join(embeddedDir, 'pgdata'),
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  })
  await embedded.initialise()
  await embedded.start()

  return {
    path: 'B-embedded',
    label: `B (ephemeral local PostgreSQL started by the harness on 127.0.0.1:${port})`,
    dbUrl: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
    usesShim: true,
  }
}

export async function shutdownDatabase() {
  if (embedded) {
    try {
      await embedded.stop()
    } catch {
      /* already down */
    }
    embedded = null
  }
  if (embeddedDir) {
    try {
      rmSync(embeddedDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    embeddedDir = null
  }
}

/* ==================================================================== *
 * Connections
 * ==================================================================== */

/** An owner/superuser connection. Bypasses RLS (it owns the tables). */
export async function ownerClient(db) {
  const client = new pg.Client({ connectionString: db.dbUrl })
  await client.connect()
  return client
}

/**
 * A pool-free client used for a single concurrent session in attack 2.
 * Callers own the lifecycle.
 */
export async function rawClient(db) {
  return ownerClient(db)
}

/* ==================================================================== *
 * Bootstrap: shim + migrations + seed + verify setup. LOOPBACK ONLY.
 * ==================================================================== */

const readSql = (p) => readFileSync(p, 'utf8')

/**
 * LOCAL-ONLY REWRITES. The embedded server has no pg_cron, so `CREATE EXTENSION ... pg_cron`
 * (migration 0018) cannot apply as written. The statement is removed on this path and the
 * shim's cron.schedule/unschedule stubs take its place. Every rewrite is listed here and
 * printed in the run header (LOCAL_REWRITE_NOTE) — never applied silently.
 */
// Each rewrite is pinned to ONE file and must match a WHOLE LINE exactly once. The line is
// replaced by a comment of its own, so nothing else on any line can be swallowed, and a match
// inside a literal or function body is impossible (it would not be a whole line). If the
// expected line moves or multiplies, the harness throws rather than guessing.
const LOCAL_REWRITES = [
  {
    file: '0018_simulated_live_feed.sql',
    line: /^CREATE EXTENSION IF NOT EXISTS pg_cron;[ \t\r]*$/m,
    replacement: '-- [verify:local] CREATE EXTENSION pg_cron removed; shim stubs cron.*',
  },
]

export const LOCAL_REWRITE_NOTE =
  'Local rewrite  : `CREATE EXTENSION IF NOT EXISTS pg_cron` removed (no pg_cron in the embedded\n' +
  '                server); cron.schedule/unschedule and storage.* are shim stubs.'

function readMigration(p) {
  let sql = readSql(p)
  const name = p.split(/[\\/]/).pop()
  for (const { file, line, replacement } of LOCAL_REWRITES) {
    if (file !== name) continue
    const all = new RegExp(line.source, 'gm')
    const count = (sql.match(all) ?? []).length
    if (count !== 1) {
      throw new Error(`local rewrite for ${file} expected exactly 1 matching line, found ${count}`)
    }
    sql = sql.replace(line, replacement)
  }
  return sql
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Resets the database to a known state and applies everything from scratch.
 *
 * Each attack calls this so the four are independent of one another and of their own
 * ordering — a shared database would make assertions like "exactly 1 pending commitment"
 * depend on which attacks ran first.
 *
 * ------------------------------------------------------------------------------------
 * THE MOST DANGEROUS FUNCTION IN THE REPOSITORY. READ THE GUARD BEFORE EDITING.
 * ------------------------------------------------------------------------------------
 * The first statement is `DROP SCHEMA IF EXISTS public CASCADE`. Pointed at the hosted
 * Supabase project it would destroy the client's entire application schema, irreversibly,
 * with no rollback and no confirmation prompt.
 *
 * The guard below makes that physically unreachable: the connection URL must resolve to a
 * loopback host or nothing is issued at all. It runs BEFORE the first query, not after,
 * and it throws rather than warning. `verify/hosted/**` additionally must not import this
 * module at all — `npm run verify` never loads this file.
 */
export async function bootstrap(db, client) {
  if (!isLoopbackDbUrl(db?.dbUrl)) {
    throw new Error(
      'REFUSING TO BOOTSTRAP: bootstrap() drops and recreates the public schema and may only ' +
        'run against a loopback PostgreSQL server. The supplied connection does not resolve ' +
        'to 127.0.0.0/8, localhost or ::1. This guard exists because the hosted Supabase ' +
        'project is one careless import away from this statement. Use `npm run verify` for ' +
        'the hosted path; it never loads this module.',
    )
  }

  await assertConnectedToLoopback(client)

  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('DROP SCHEMA IF EXISTS auth CASCADE')
  await client.query('DROP SCHEMA IF EXISTS storage CASCADE')
  await client.query('DROP SCHEMA IF EXISTS cron CASCADE')
  await client.query('CREATE SCHEMA public')

  // The shim supplies the minimum auth surface the migrations reference. It is applied on
  // every local path; there is no non-shim path here any more.
  await client.query(readSql(SHIM))

  for (const f of migrationFiles()) {
    try {
      await client.query(readMigration(join(MIGRATIONS_DIR, f)))
    } catch (err) {
      throw new Error(`migration ${f} failed to apply: ${err.message}`)
    }
  }

  // 0003_seed_demo_delta.sql is deliberately excluded: it depends on a profile existing and
  // would move the SEA-9007 baseline the attacks assert against.
  for (const f of ['0001_seed_catalogue.sql', '0002_seed_fixtures.sql']) {
    await client.query(readSql(join(SEED_DIR, f)))
  }

  await client.query(readSql(SETUP))
}

/* ==================================================================== *
 * Identity — asRep / asAdmin / asAnon
 *
 * SET LOCAL ROLE is what makes RLS apply. Without it the harness runs as the table owner
 * and every policy is bypassed, producing a set of false passes. These helpers exist so no
 * test writes those two lines by hand and forgets one.
 * ==================================================================== */

async function beginAs(client, role, uid) {
  await client.query('BEGIN')
  if (uid) {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role }),
    ])
  } else {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role }),
    ])
  }
  await client.query(`SET LOCAL ROLE ${role}`)
}

/**
 * Runs `fn(client)` inside a transaction as the given identity, then ROLLBACKs by default.
 * Pass { commit: true } where the test needs the write to persist.
 */
export async function asIdentity(client, role, uid, fn, { commit = false } = {}) {
  await beginAs(client, role, uid)
  try {
    const result = await fn(client)
    await client.query(commit ? 'COMMIT' : 'ROLLBACK')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection may be in a bad state */
    }
    throw err
  }
}

export const asRep = (client, fn, opts) => asIdentity(client, 'authenticated', REP_UID, fn, opts)
export const asAdmin = (client, fn, opts) => asIdentity(client, 'authenticated', ADMIN_UID, fn, opts)
export const asAnon = (client, fn, opts) => asIdentity(client, 'anon', null, fn, opts)

/**
 * Runs a single statement as an identity and reports the outcome without throwing, so a
 * test can assert on the SQLSTATE. Always rolls back.
 */
export async function attempt(client, role, uid, sql, params = []) {
  await beginAs(client, role, uid)
  try {
    const res = await client.query(sql, params)
    await client.query('ROLLBACK')
    return { ok: true, rows: res.rows, rowCount: res.rowCount, code: null, message: null }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, rows: [], rowCount: 0, code: err.code ?? null, message: err.message }
  }
}

export const repAttempt = (client, sql, params) => attempt(client, 'authenticated', REP_UID, sql, params)
export const adminAttempt = (client, sql, params) => attempt(client, 'authenticated', ADMIN_UID, sql, params)
export const anonAttempt = (client, sql, params) => attempt(client, 'anon', null, sql, params)

/* ==================================================================== *
 * Assertions and reporting
 *
 * The Report class lives in ./report.mjs — it touches no database and is the only code
 * shared with the hosted runner. It is re-exported at the top of this file so the four
 * attack files can keep importing it from here.
 * ==================================================================== */

/* ==================================================================== *
 * Small query helpers
 * ==================================================================== */

/** Reads one row from v_inventory as the table owner (no RLS in play, used for oracles). */
export async function inventoryRow(client, sku) {
  const { rows } = await client.query(
    'SELECT * FROM public.v_inventory WHERE sku = $1 AND location = $2',
    [sku, 'default'],
  )
  return rows[0]
}

/**
 * Seeds one HISTORICAL commitment row as the table owner. Since 0025 the portal has no write
 * path to `commitments` (record_commitment is dropped, write privileges revoked); the table is
 * read-only history. Attack 1 still needs one rep-owned and one admin-owned row to prove the
 * read-isolation policy, so they are inserted here, outside any client identity.
 */
export async function seedHistoricalCommitment(client, uid, sku, qty, note = null) {
  const { rows } = await client.query(
    `INSERT INTO public.commitments (sku, location, qty, rep_id, state, note)
     VALUES ($1, 'default', $2, $3, 'pending', $4)
     RETURNING *`,
    [sku, qty, uid, note],
  )
  return rows[0]
}

/** Runs apply_inventory_sync as an identity, committing it. */
export async function applySyncAs(client, uid, payload) {
  await beginAs(client, 'authenticated', uid)
  try {
    const { rows } = await client.query('SELECT public.apply_inventory_sync($1::jsonb) AS report', [
      JSON.stringify(payload),
    ])
    await client.query('COMMIT')
    return { ok: true, report: rows[0].report }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, code: err.code ?? null, message: err.message }
  }
}

export const PATH_CAVEAT = `
  SCOPE: POLICY LOGIC ONLY.
  This run exercises RLS policy logic, function guards and concurrency control against an
  ephemeral local PostgreSQL server. It sets request.jwt.claims directly.
  It does NOT cover: identity issuance, JWT signing, JWT verification, PostgREST request
  handling, or session handling. Those are GoTrue's and PostgREST's job and are exercised
  only by \`npm run verify\` against the configured hosted project.
  A pass here must never be reported as a claim about the hosted project.`
