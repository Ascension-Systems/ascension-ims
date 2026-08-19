/**
 * ATTACK 2 — concurrent commitment on the last unit, against the hosted project.
 *
 * ------------------------------------------------------------------------------------
 * WHAT THIS PROVES, AND THE ONE THING IT DOES NOT. BOTH ARE PRINTED, NEITHER IS GLOSSED.
 * ------------------------------------------------------------------------------------
 * N unawaited HTTPS requests to the `record_commitment` RPC land on separate PostgREST
 * backends and separate Postgres connections. Each acquires the FOR UPDATE row lock in turn
 * and the outcome is decided by the database's serialisation, not by the client. That is
 * two-or-more genuinely concurrent real connections against the configured remote database:
 * not sequential, not simulated interleaving, not mocked. 2b.0 supplies direct wall-clock
 * evidence that the requests overlapped rather than assuming it.
 *
 * THE RESIDUAL GAP, STATED PLAINLY: 2b proves the OUTCOME is correctly serialised. It does
 * NOT provide direct evidence of BLOCKING. "B's call is still unsettled after 500 ms" is
 * what distinguishes a correct lock from a lucky race, and that observation needs a
 * transaction held open across statements, which PostgREST does not have at any N. It is
 * preserved under `npm run verify:local`. The honest summary line is:
 *
 *   serialisation outcome verified against hosted; blocking behaviour verified only under
 *   verify:local
 *
 * and this file prints exactly that rather than letting 2b's passes imply 2a's claim.
 *
 * ENVIRONMENTAL CAVEAT, also printed: Supabase's PostgREST connection pool may be shallower
 * than N, so some of the 20 may queue. That does not weaken any assertion — the pass
 * condition is exactly 1 (or exactly 3) winners regardless of how many run at once — but it
 * means N is a lower bound on observed concurrency, not a guarantee of 20-way parallelism.
 */

import { Report } from '../lib/report.mjs'
import { inventoryRow, appFetch, isLoginRedirect } from './lib/client.mjs'
import { KYV_LOCATION, SKU, resetFixtures, pendingCount } from './lib/fixtures.mjs'

const METHOD = `20 unawaited HTTPS requests to the record_commitment RPC, fired without
awaiting and then collected with Promise.all, against a fixture whose
availability is exactly 1 and then exactly 3. Send and first-response
timestamps are recorded for every request and the peak number in flight is
computed, so the overlap is evidenced rather than assumed. Every write is in
the KYV namespace; SEA-9006 is not touched.`

const SWARM_SIZE = 20

/**
 * Fires `n` requests without awaiting any of them, recording when each was sent and when its
 * response headers arrived. `performance.now()` is monotonic, so a clock adjustment mid-run
 * cannot manufacture an overlap that did not happen.
 */
async function swarm(cfg, identity, sku, qty, n) {
  const url = `${cfg.restUrl}/rpc/record_commitment`
  const headers = {
    ...identity.headers,
    'content-type': 'application/json',
    accept: 'application/json',
  }
  const body = JSON.stringify({
    p_sku: sku,
    p_qty: qty,
    p_location: KYV_LOCATION,
    p_note: 'KYV verification artefact - concurrency swarm',
  })

  const inflight = []
  for (let i = 0; i < n; i += 1) {
    const sent = performance.now()
    inflight.push(
      fetch(url, { method: 'POST', headers, body })
        .then(async (res) => {
          const returned = performance.now()
          const text = await res.text()
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = { raw: text }
          }
          return {
            i,
            sent,
            returned,
            ok: res.ok,
            status: res.status,
            code: res.ok ? null : (parsed?.code ?? `HTTP_${res.status}`),
            message: res.ok ? null : (parsed?.message ?? `HTTP ${res.status}`),
          }
        })
        .catch((err) => ({
          i,
          sent,
          returned: performance.now(),
          ok: false,
          status: 0,
          code: 'ENETWORK',
          message: err?.message ?? String(err),
        })),
    )
  }
  return Promise.all(inflight)
}

/** Peak number of requests simultaneously in flight, by sweeping the send/return events. */
function peakConcurrency(results) {
  const events = []
  for (const r of results) {
    events.push({ t: r.sent, d: +1 })
    events.push({ t: r.returned, d: -1 })
  }
  // A return at exactly the same timestamp as a send is processed first, so the count is a
  // lower bound rather than an optimistic one.
  events.sort((a, b) => a.t - b.t || a.d - b.d)
  let cur = 0
  let peak = 0
  for (const e of events) {
    cur += e.d
    if (cur > peak) peak = cur
  }
  return peak
}

export default async function attack2(ctx) {
  const { cfg, identities, oracle, app } = ctx
  const report = new Report(2, 'Concurrent commitment on the last unit', METHOD)

  await resetFixtures(cfg, identities)

  const start = await inventoryRow(cfg, oracle, SKU.CONT1, KYV_LOCATION)
  report.equals(
    '2a.0',
    `${SKU.CONT1} starts with availability of exactly 1`,
    start?.qty_available,
    1,
  )

  /* ================================================================ *
   * 2a — the deterministic interleaving. NOT REACHABLE OVER POSTGREST.
   *
   * Every one of these needs a transaction held open across statements,
   * or pg_catalog, or both. Neither exists on this channel. They are
   * reported as NOT EXECUTED with the reason, never approximated, and
   * they still run under `npm run verify:local`.
   * ================================================================ */
  const NO_TXN =
    'PostgREST has no open transactions — each request is its own transaction and commits ' +
    'when it returns, so there is no held lock to observe. Runs under `npm run verify:local`.'
  const NO_CATALOG =
    'pg_catalog is not exposed over PostgREST: pg_locks, pg_stat_activity and ' +
    'pg_blocking_pids are unreachable. Runs under `npm run verify:local`.'

  report.notExecuted('2a.1', 'A succeeds inside its open transaction', NO_TXN)
  report.notExecuted(
    '2a.2',
    'B is still blocked 500ms later while A holds the lock',
    `${NO_TXN} THIS IS THE ONLY DIRECT EVIDENCE OF BLOCKING as opposed to correct ` +
      'serialisation, and it is unavailable over this channel at any level of concurrency. ' +
      '2b below proves the outcome, not the blocking.',
  )
  report.notExecuted('2a.3', 'pg_blocking_pids shows a backend waiting on a lock', NO_CATALOG)
  report.notExecuted(
    '2a.4',
    'the blocked backend holds RowShareLock on inventory',
    NO_CATALOG,
  )
  report.notExecuted('2a.5', 'B fails once A commits', NO_TXN)
  report.notExecuted(
    '2a.6',
    'B fails with SQLSTATE KY001',
    `${NO_TXN} Covered in substance by 2b.2, which asserts KY001 on every losing caller of a real swarm.`,
  )
  report.notExecuted(
    '2a.7',
    "B's message matches 'insufficient availability'",
    `${NO_TXN} Recovered as 2b.2b below, asserted on every real losing swarm caller.`,
  )
  report.notExecuted(
    '2a.8',
    'exactly 1 pending commitment on the contended sku',
    `${NO_TXN} Covered by 2b.4.`,
  )
  report.notExecuted('2a.9', 'qty_available is 0, never negative', `${NO_TXN} Covered by 2b.5.`)

  /* ================================================================ *
   * 2b — the swarm, 1 unit
   * ================================================================ */
  const swarm1 = await swarm(cfg, identities.rep, SKU.CONT1, 1, SWARM_SIZE)
  const peak1 = peakConcurrency(swarm1)

  report.check(
    '2b.0',
    `at least 2 of the ${SWARM_SIZE} requests were in flight simultaneously`,
    peak1 >= 2,
    `peak concurrency observed was ${peak1}; the requests did not overlap, so this run proves nothing about concurrency`,
  )

  const won1 = swarm1.filter((r) => r.ok).length
  const lost1 = swarm1.filter((r) => !r.ok && r.code === 'KY001')
  const other1 = swarm1.filter((r) => !r.ok && r.code !== 'KY001')

  report.equals('2b.1', `${SWARM_SIZE}-way swarm on 1 unit: exactly 1 succeeds`, won1, 1)
  report.equals(
    '2b.2',
    `${SWARM_SIZE}-way swarm on 1 unit: exactly ${SWARM_SIZE - 1} refused with KY001`,
    lost1.length,
    SWARM_SIZE - 1,
  )
  report.check(
    '2b.2b',
    "every refusal's message matches 'insufficient availability'",
    lost1.length > 0 && lost1.every((r) => /insufficient availability/i.test(r.message ?? '')),
    `messages: ${JSON.stringify([...new Set(lost1.map((r) => (r.message ?? '').slice(0, 80)))])}`,
  )
  report.check(
    '2b.3',
    'no caller failed for any other reason',
    other1.length === 0,
    `unexpected failures: ${JSON.stringify(other1.map((r) => [r.status, r.code, (r.message ?? '').slice(0, 60)]))}`,
  )
  report.equals(
    '2b.4',
    'exactly 1 pending commitment row',
    await pendingCount(cfg, identities, SKU.CONT1),
    1,
  )
  report.equals(
    '2b.5',
    'qty_available is 0',
    (await inventoryRow(cfg, oracle, SKU.CONT1, KYV_LOCATION))?.qty_available,
    0,
  )

  /* ================================================================ *
   * 2a.10 — the same losing call through the HTTP surface, now that the
   *         swarm has driven the contended fixture to availability 0.
   *         It fails, so it writes nothing.
   * ================================================================ */
  if (!app.usable) {
    report.notExecuted(
      '2a.10',
      'POST /api/commitments returns 409 INSUFFICIENT_AVAILABILITY',
      `${app.reason}${app.detail ? ` — ${app.detail}` : ''}`,
    )
  } else {
    const res = await appFetch(cfg.portalBaseUrl, '/api/commitments', {
      method: 'POST',
      cookie: app.cookie,
      body: { sku: SKU.CONT1, qty: 1, location: KYV_LOCATION },
    })
    report.check(
      '2a.10',
      'POST /api/commitments returns 409 INSUFFICIENT_AVAILABILITY',
      res.status === 409 && res.body?.error === 'INSUFFICIENT_AVAILABILITY',
      `observed HTTP ${res.status}${isLoginRedirect(res) ? ' (middleware redirect to /login)' : ''} ${JSON.stringify(res.body)}`,
    )
  }

  /* ================================================================ *
   * 2b — the swarm, 3 units. Catches an off-by-one a 1-unit test would
   *      not. The plain, non-unique partial index permits 3 pending rows.
   * ================================================================ */
  const swarm3 = await swarm(cfg, identities.rep, SKU.CONT3, 1, SWARM_SIZE)
  const peak3 = peakConcurrency(swarm3)
  const won3 = swarm3.filter((r) => r.ok).length
  const lost3 = swarm3.filter((r) => !r.ok && r.code === 'KY001').length

  report.equals('2b.6', `${SWARM_SIZE}-way swarm on 3 units: exactly 3 succeed`, won3, 3)
  report.equals(
    '2b.7',
    `${SWARM_SIZE}-way swarm on 3 units: exactly ${SWARM_SIZE - 3} refused with KY001`,
    lost3,
    SWARM_SIZE - 3,
  )
  report.equals(
    '2b.8',
    'exactly 3 pending commitment rows',
    await pendingCount(cfg, identities, SKU.CONT3),
    3,
  )
  report.equals(
    '2b.9',
    'qty_available is 0, never negative',
    (await inventoryRow(cfg, oracle, SKU.CONT3, KYV_LOCATION))?.qty_available,
    0,
  )

  /* ================================================================ *
   * 2b.10 — different SKUs must not contend.
   *
   * DO NOT APPROXIMATE THIS. It needs a lock held across statements;
   * without one there is nothing to block behind, and a "fast second SKU"
   * result would prove nothing while looking like a pass.
   * ================================================================ */
  report.notExecuted(
    '2b.10',
    'a commitment on a DIFFERENT sku does not block behind the held lock',
    'requires a lock held open across statements, which PostgREST does not have. Without a ' +
      'held lock there is nothing to block behind, so a fast second SKU would prove nothing ' +
      'while looking like a pass. Runs under `npm run verify:local`.',
  )

  report.notes = [
    `Peak requests in flight: ${peak1} of ${SWARM_SIZE} (1-unit swarm), ${peak3} of ${SWARM_SIZE} (3-unit swarm).`,
    "Supabase's PostgREST connection pool may be shallower than the swarm size, so some",
    'requests may queue. That does not weaken any assertion — the pass condition is exactly 1',
    '(or exactly 3) winners regardless of how many run at once — but the observed peak is a',
    'lower bound on concurrency, not a guarantee of 20-way parallelism.',
    'Serialisation outcome verified against hosted; blocking behaviour verified only under',
    'verify:local.',
  ]

  return report
}
