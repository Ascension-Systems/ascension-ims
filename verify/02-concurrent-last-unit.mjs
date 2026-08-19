/**
 * ATTACK 2 — concurrent commitment on the last unit.
 *
 * Two genuinely concurrent connections on SEA-9006 (availability exactly 1).
 *
 * FAILURE OF THIS TEST IS A DESIGN FAILURE, NOT A FLAKE. If it fails, the fix is in
 * record_commitment, not in the test.
 *
 * 2a — deterministic interleaving, which proves SERIALISATION rather than luck:
 *
 *   A: BEGIN
 *   A: SELECT record_commitment('SEA-9006', 1)   -- takes the FOR UPDATE row lock, inserts
 *      (A does NOT commit yet)
 *   B: BEGIN
 *   B: SELECT record_commitment('SEA-9006', 1)   -- MUST BLOCK on A's row lock
 *      harness waits 500ms and asserts B's promise is still unsettled   <-- the key assertion
 *      harness asserts pg_blocking_pids shows B waiting on A
 *   A: COMMIT
 *   B: proceeds, recomputes pending inside the lock (now sees A's row), and raises KY001
 *
 * A naive read-then-write would have returned immediately with a success.
 *
 * 2b — stochastic swarm, which catches what a fixed interleaving can miss.
 */

import pg from 'pg'
import {
  Report,
  ownerClient,
  bootstrap,
  inventoryRow,
  pendingCount,
  REP_UID,
  ADMIN_UID,
} from './lib/harness.mjs'

const METHOD = `two concurrent pg connections; A holds the FOR UPDATE row lock inside an open
transaction while B calls record_commitment on the same SKU; B asserted
blocked for >500ms and observed waiting in pg_blocking_pids, then A commits
and B is observed to fail with KY001. Repeated as a 20-way Promise.all
swarm on a 1-unit and a 3-unit SKU.`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Opens a connection and puts it in an `authenticated` session for `uid`. */
async function session(db, uid) {
  const client = new pg.Client({ connectionString: db.dbUrl })
  await client.connect()
  await client.query('BEGIN')
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ])
  await client.query('SET LOCAL ROLE authenticated')
  return client
}

/** One shot: connect, commit a unit, disconnect. Used by the swarm. */
async function oneShot(db, uid, sku, qty) {
  const client = new pg.Client({ connectionString: db.dbUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role: 'authenticated' }),
    ])
    await client.query('SET LOCAL ROLE authenticated')
    const { rows } = await client.query('SELECT public.record_commitment($1, $2) AS c', [sku, qty])
    await client.query('COMMIT')
    return { ok: true, row: rows[0].c }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, code: err.code ?? null, message: err.message }
  } finally {
    await client.end()
  }
}

/** Resets the contended SKU to a known on-hand with no portal commitments. */
async function resetSku(owner, sku, onHand) {
  await owner.query(`DELETE FROM public.commitments WHERE sku = $1`, [sku])
  await owner.query(
    `UPDATE public.inventory SET qty_on_hand = $2, qty_committed = 0 WHERE sku = $1 AND location = 'default'`,
    [sku, onHand],
  )
}

export default async function attack2(db) {
  const report = new Report(2, 'Concurrent commitment on the last unit', METHOD)
  const owner = await ownerClient(db)
  let a = null
  let b = null

  try {
    await bootstrap(db, owner)

    const start = await inventoryRow(owner, 'SEA-9006')
    report.equals('2a.0', 'SEA-9006 starts with availability of exactly 1', start.qty_available, 1)

    /* ================================================================ *
     * 2a — deterministic interleaving
     * ================================================================ */
    a = await session(db, REP_UID)
    b = await session(db, ADMIN_UID)

    // A takes the lock and inserts, but does NOT commit.
    const aResult = await a.query('SELECT public.record_commitment($1, $2) AS c', ['SEA-9006', 1])
    report.check('2a.1', 'A succeeds inside its open transaction', Boolean(aResult.rows[0].c), '')

    // B calls the same thing. It must block on A's row lock.
    let bSettled = false
    let bError = null
    const bPromise = b
      .query('SELECT public.record_commitment($1, $2) AS c', ['SEA-9006', 1])
      .then(() => {
        bSettled = true
      })
      .catch((err) => {
        bSettled = true
        bError = err
      })

    await sleep(500)

    report.check(
      '2a.2',
      'B is still blocked 500ms later while A holds the lock',
      bSettled === false,
      bSettled
        ? 'B returned while A was still open — the availability read is not inside the lock'
        : '',
    )

    // Independent evidence from the server: B's backend is waiting on A's.
    const blocking = await owner.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, left(query, 60) AS q
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(pid)) > 0`,
    )
    report.check(
      '2a.3',
      'pg_blocking_pids shows a backend waiting on a lock',
      blocking.rows.length >= 1 && blocking.rows[0].wait_event_type === 'Lock',
      `pg_stat_activity reported ${blocking.rows.length} blocked backends: ${JSON.stringify(blocking.rows)}`,
    )

    // Tie the wait to the inventory ROW specifically.
    //
    // A SELECT ... FOR UPDATE waiter does NOT show an ungranted lock on the relation: it has
    // already been granted its RowShareLock on `inventory`, and is then queued on a `tuple`
    // lock and/or on the holder's `transactionid`. Asserting on an ungranted relation lock
    // finds nothing and would silently never fire.
    const blockedPid = blocking.rows[0]?.pid
    const locks = blockedPid
      ? (
          await owner.query(
            `SELECT l.locktype, l.granted, l.mode, c.relname
               FROM pg_locks l
               LEFT JOIN pg_class c ON c.oid = l.relation
              WHERE l.pid = $1`,
            [blockedPid],
          )
        ).rows
      : []

    const waitingOnRowLock = locks.some(
      (l) => l.granted === false && (l.locktype === 'transactionid' || l.locktype === 'tuple'),
    )
    const holdsInventoryLock = locks.some(
      (l) => l.granted === true && l.relname === 'inventory' && l.mode === 'RowShareLock',
    )

    report.check(
      '2a.4',
      'the blocked backend holds RowShareLock on inventory and waits on a row-level lock',
      waitingOnRowLock && holdsInventoryLock,
      `locks for pid ${blockedPid}: ${JSON.stringify(locks)}`,
    )

    // Release A. B now proceeds, recomputes inside the lock, and must raise.
    await a.query('COMMIT')
    await bPromise

    report.check(
      '2a.5',
      'B fails once A commits',
      bSettled === true && bError !== null,
      bError === null ? 'B SUCCEEDED — both sessions committed the same unit' : '',
    )
    report.check(
      '2a.6',
      'B fails with SQLSTATE KY001',
      bError?.code === 'KY001',
      `observed ${bError?.code}: ${bError?.message}`,
    )
    report.check(
      '2a.7',
      "B's message matches 'insufficient availability'",
      /insufficient availability/i.test(bError?.message ?? ''),
      `observed message: ${bError?.message}`,
    )

    try {
      await b.query('ROLLBACK')
    } catch {
      /* already aborted */
    }

    const pending = await pendingCount(owner, 'SEA-9006')
    report.equals('2a.8', 'exactly 1 pending commitment on SEA-9006', pending, 1)

    const afterRow = await inventoryRow(owner, 'SEA-9006')
    report.equals('2a.9', 'qty_available is 0, never negative', afterRow.qty_available, 0)

    /* ================================================================ *
     * 2a.10 — the same losing call through the HTTP surface
     * ================================================================ */
    report.notExecuted(
      '2a.10',
      'POST /api/commitments returns 409 INSUFFICIENT_AVAILABILITY',
      'NOT RUN ON THIS PATH, BY DESIGN. This runner exercises policy logic only — it does ' +
        'not cover PostgREST request handling or session handling, so it has no session a ' +
        'running app would accept and cannot mint one. The database-level refusal above is ' +
        'executed for real; the HTTP mapping in lib/errors.ts is exercised by ' +
        '`npm run verify` with PORTAL_BASE_URL set, where the harness mints a real session ' +
        'itself. No operator-supplied cookie is accepted anywhere.',
    )

    /* ================================================================ *
     * 2b — stochastic swarm, 1 unit
     * ================================================================ */
    await resetSku(owner, 'SEA-9006', 1)
    const swarm1 = await Promise.all(
      Array.from({ length: 20 }, () => oneShot(db, REP_UID, 'SEA-9006', 1)),
    )
    const won1 = swarm1.filter((r) => r.ok).length
    const lost1 = swarm1.filter((r) => !r.ok && r.code === 'KY001').length
    const other1 = swarm1.filter((r) => !r.ok && r.code !== 'KY001')

    report.equals('2b.1', '20-way swarm on 1 unit: exactly 1 succeeds', won1, 1)
    report.equals('2b.2', '20-way swarm on 1 unit: exactly 19 refused with KY001', lost1, 19)
    report.check(
      '2b.3',
      'no caller failed for any other reason',
      other1.length === 0,
      `unexpected failures: ${JSON.stringify(other1.map((r) => [r.code, r.message?.slice(0, 60)]))}`,
    )
    report.equals('2b.4', 'exactly 1 pending commitment row', await pendingCount(owner, 'SEA-9006'), 1)
    report.equals(
      '2b.5',
      'qty_available is 0',
      (await inventoryRow(owner, 'SEA-9006')).qty_available,
      0,
    )

    /* ================================================================ *
     * 2b — stochastic swarm, 3 units. Catches an off-by-one a 1-unit
     *      test would not.
     * ================================================================ */
    await resetSku(owner, 'SEA-9006', 3)
    const swarm3 = await Promise.all(
      Array.from({ length: 20 }, () => oneShot(db, REP_UID, 'SEA-9006', 1)),
    )
    const won3 = swarm3.filter((r) => r.ok).length
    const lost3 = swarm3.filter((r) => !r.ok && r.code === 'KY001').length

    report.equals('2b.6', '20-way swarm on 3 units: exactly 3 succeed', won3, 3)
    report.equals('2b.7', '20-way swarm on 3 units: exactly 17 refused with KY001', lost3, 17)
    report.equals('2b.8', 'exactly 3 pending commitment rows', await pendingCount(owner, 'SEA-9006'), 3)
    report.equals(
      '2b.9',
      'qty_available is 0, never negative',
      (await inventoryRow(owner, 'SEA-9006')).qty_available,
      0,
    )

    /* ================================================================ *
     * 2b.10 — different SKUs must NOT contend. Proves the lock is on the
     *         row, not a table-wide or hash-collision-prone construct.
     * ================================================================ */
    await resetSku(owner, 'SEA-9006', 1)
    const holder = await session(db, REP_UID)
    await holder.query('SELECT public.record_commitment($1, $2) AS c', ['SEA-9006', 1])
    const otherSku = await Promise.race([
      oneShot(db, ADMIN_UID, 'SEA-9007', 1).then((r) => ({ ...r, timedOut: false })),
      sleep(1500).then(() => ({ timedOut: true })),
    ])
    await holder.query('ROLLBACK')
    await holder.end()
    report.check(
      '2b.10',
      'a commitment on a DIFFERENT sku does not block behind the held lock',
      otherSku.timedOut === false && otherSku.ok === true,
      otherSku.timedOut
        ? 'the second SKU blocked — the lock is not row-scoped'
        : `code=${otherSku.code} ${otherSku.message ?? ''}`,
    )

    return report
  } finally {
    for (const c of [a, b]) {
      if (c) {
        try {
          await c.end()
        } catch {
          /* ignore */
        }
      }
    }
    await owner.end()
  }
}
