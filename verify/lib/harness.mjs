/**
 * Verification harness — shared plumbing.
 *
 * ASSERTIONS ARE MADE AGAINST A REAL DATABASE, NEVER AGAINST MOCKS. A mocked RLS policy
 * proves nothing; that is the whole point of the four attacks.
 *
 * Nothing in this file connects to the hosted Supabase project. It stands up, or connects
 * to, a LOCAL Postgres and applies the committed migrations to it.
 *
 * ------------------------------------------------------------------------------------
 * THREE WAYS TO GET A LOCAL DATABASE. run-all.mjs prints which one was used, because the
 * answer changes what the results mean.
 * ------------------------------------------------------------------------------------
 *
 *  PATH A  — Supabase CLI + Docker.  `supabase start`
 *            The real thing: auth schema, real auth.users, real auth.uid(), real
 *            anon/authenticated/service_role roles, GoTrue. RLS behaves exactly as it will
 *            in production. Selected automatically when `supabase status -o json` succeeds.
 *
 *            CREDENTIAL RULE: the local stack's keys are read at runtime from
 *            `supabase status -o json` and are NEVER hardcoded — not even the well-known
 *            local-development defaults. A key-shaped string in the repo fails
 *            scripts/check-no-secrets.sh regardless of whether it happens to be public.
 *
 *  PATH B  — plain psql/pg against a local Postgres you already run.
 *            Selected when VERIFY_DATABASE_URL is set. Applies verify/shim/00_auth_shim.sql
 *            first, which supplies the minimum auth surface the migrations reference.
 *
 *  PATH B' — an ephemeral Postgres started by this harness (`embedded-postgres`), used when
 *            neither of the above is available. Same shim, same migrations, a real
 *            PostgreSQL server process on a loopback port, torn down at the end. Its
 *            superuser password is generated at runtime with crypto.randomBytes and is never
 *            written to disk or to the repo.
 *
 * HONEST LIMITATION, stated rather than papered over: under Path B/B' the harness asserts
 * its own identity by setting the request.jwt.claims GUC directly. That proves the POLICIES
 * are correct given an identity; it does NOT prove that JWT signing, verification or session
 * handling are correct — those are GoTrue's job and are exercised only under Path A and by
 * manual sign-in against the deployed app.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import pg from 'pg'

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

function detectSupabaseCli() {
  try {
    const out = execFileSync('supabase', ['status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: REPO,
    })
    const status = JSON.parse(out)
    if (status.DB_URL) return { dbUrl: status.DB_URL, status }
  } catch {
    /* not available; fall through */
  }
  return null
}

let embedded = null
let embeddedDir = null

/**
 * Resolves a live local Postgres and returns { path, label, dbUrl, usesShim }.
 * `path` is 'A' | 'B' | 'B-embedded'.
 */
export async function resolveDatabase() {
  const cli = detectSupabaseCli()
  if (cli) {
    return {
      path: 'A',
      label: 'A (supabase start / docker)',
      dbUrl: cli.dbUrl,
      usesShim: false,
    }
  }

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
 * Bootstrap: shim (Path B) + migrations + seed + verify setup
 * ==================================================================== */

const readSql = (p) => readFileSync(p, 'utf8')

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
 */
export async function bootstrap(db, client) {
  // Under Path A the auth schema belongs to GoTrue and must survive; only public is reset.
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  if (db.usesShim) {
    await client.query('DROP SCHEMA IF EXISTS auth CASCADE')
  }
  await client.query('CREATE SCHEMA public')

  if (db.usesShim) {
    await client.query(readSql(SHIM))
  } else {
    // Path A: clear any verification identities left by a previous run so the profile
    // trigger fires cleanly on re-insert.
    await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [[REP_UID, ADMIN_UID]])
  }

  for (const f of migrationFiles()) {
    try {
      await client.query(readSql(join(MIGRATIONS_DIR, f)))
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
 * ==================================================================== */

export class Report {
  constructor(number, title, method) {
    this.number = number
    this.title = title
    this.method = method
    this.results = []
    this.skips = 0
  }

  pass(id, description) {
    this.results.push({ id, description, status: 'PASS' })
  }

  fail(id, description, detail) {
    this.results.push({ id, description, status: 'FAIL', detail })
  }

  skip(id, description, reason) {
    this.skips += 1
    this.results.push({ id, description, status: 'SKIP', detail: reason })
  }

  /** Generic assertion. `detail` is printed on failure. */
  check(id, description, condition, detail = '') {
    if (condition) this.pass(id, description)
    else this.fail(id, description, detail)
    return condition
  }

  /** Asserts a refusal: the operation must have failed with `expectedCode`. */
  refused(id, description, outcome, expectedCode) {
    const ok = outcome.ok === false && outcome.code === expectedCode
    return this.check(
      id,
      description,
      ok,
      outcome.ok
        ? `expected SQLSTATE ${expectedCode}, but the statement SUCCEEDED (${outcome.rowCount} rows affected)`
        : `expected SQLSTATE ${expectedCode}, observed ${outcome.code}: ${outcome.message}`,
    )
  }

  /** Asserts an operation succeeded. Used by the control cases. */
  allowed(id, description, outcome) {
    return this.check(
      id,
      description,
      outcome.ok === true,
      outcome.ok ? '' : `expected success, observed ${outcome.code}: ${outcome.message}`,
    )
  }

  equals(id, description, actual, expected) {
    return this.check(
      id,
      description,
      Object.is(actual, expected) || String(actual) === String(expected),
      `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
    )
  }

  get passed() {
    return this.results.filter((r) => r.status === 'PASS').length
  }

  get failed() {
    return this.results.filter((r) => r.status === 'FAIL').length
  }

  get total() {
    return this.results.length
  }

  get ok() {
    return this.failed === 0
  }

  print(pathLabel) {
    const width = 58
    const lines = []
    lines.push('')
    lines.push(`ATTACK ${this.number} — ${this.title}`)
    lines.push(`  Path:   ${pathLabel}`)
    lines.push(`  Method: ${this.method.trim().split('\n').join('\n          ')}`)
    for (const r of this.results) {
      const dots = '.'.repeat(Math.max(3, width - r.id.length - r.description.length))
      lines.push(`  ${r.id} ${r.description} ${dots} ${r.status}`)
      if (r.status !== 'PASS' && r.detail) {
        lines.push(`       ↳ ${r.detail}`)
      }
    }
    const skipNote = this.skips ? `, ${this.skips} skipped` : ''
    lines.push(
      `  RESULT: ${this.ok ? 'PASS' : 'FAIL'} (${this.passed}/${this.total - this.skips} assertions${skipNote})`,
    )
    process.stdout.write(lines.join('\n') + '\n')
  }
}

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

export async function pendingCount(client, sku) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM public.commitments
      WHERE sku = $1 AND location = 'default' AND state = 'pending'`,
    [sku],
  )
  return rows[0].n
}

/** Records a commitment as an identity, committing it. Returns { ok, row | code, message }. */
export async function recordCommitmentAs(client, uid, sku, qty, note = null) {
  await beginAs(client, 'authenticated', uid)
  try {
    const { rows } = await client.query(
      'SELECT * FROM public.record_commitment($1, $2, $3, $4) AS c',
      [sku, qty, 'default', note],
    )
    await client.query('COMMIT')
    return { ok: true, row: rows[0] }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, code: err.code ?? null, message: err.message }
  }
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
  Under Path B the harness asserts its own identity by setting the request.jwt.claims GUC
  directly. Path B therefore proves the POLICIES are correct given an identity; it does NOT
  prove that JWT signing, verification or session handling are correct. Those are GoTrue's
  job and are exercised only under Path A and by manual sign-in against the deployed app.
  A Path B pass must not be reported as a stronger claim than that.`
