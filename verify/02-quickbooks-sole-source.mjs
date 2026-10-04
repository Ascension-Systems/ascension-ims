/**
 * ATTACK 2 — QuickBooks is the only source of "committed".
 *
 * Replaces the portal-commitment attacks (old 2 "concurrent commitment on the last unit" and
 * old 3 "delta survives a stale baseline"), retired with migration 0025: the portal no longer
 * records commitments, so there is no ledger to race or to retire early. What must hold now:
 *
 *   * the figures a rep reads are the source's figures, unblended and unclamped (2.1–2.3);
 *   * no client can create, change or delete a commitment, by RPC or by table (2.4, 2.5);
 *   * a stale caller still sending commitment matches fails loudly (2.6);
 *   * only an admin (or service_role) can apply a sync (2.7);
 *   * an admin's on-hand correction survives a sync, QuickBooks' committed still flows into it,
 *     and the correction stays credited to the admin who made it (2.8, 2.8b);
 *   * no portal INSERT can enter a committed figure (2.9).
 */

import {
  Report,
  ownerClient,
  bootstrap,
  repAttempt,
  adminAttempt,
  attempt,
  asAdmin,
  applySyncAs,
  REP_UID,
  ADMIN_UID,
} from './lib/harness.mjs'

const METHOD = `figures are read through v_inventory in a rep session and compared with the
owner's read of the inventory table; syncs are applied through
apply_inventory_sync as admin identities; every forbidden action is issued
directly over SQL and asserted by SQLSTATE; attribution is compared before
and after a sync run by a second admin.`

const ADMIN2_UID = '00000000-0000-4000-8000-000000000003'

const ownerRow = async (client, sku) =>
  (
    await client.query(
      `SELECT qty_on_hand, qty_committed, qty_incoming, source, override_by, override_at
         FROM public.inventory WHERE sku = $1 AND location = 'default'`,
      [sku],
    )
  ).rows[0]

const sourceRow = (sku, onHand, committed, incoming = 0) => ({
  sku,
  location: 'default',
  qty_on_hand: onHand,
  qty_committed: committed,
  qty_incoming: incoming,
  incoming_eta: null,
  source: 'quickbooks_stub',
  source_payload: null,
})

export default async function attack2(db) {
  const report = new Report(2, 'QuickBooks is the only source of committed', METHOD)
  const client = await ownerClient(db)

  try {
    await bootstrap(db, client)

    /* ---------------------------------------------------------------- *
     * 2.1 / 2.2 — the rep's figures are the source's figures.
     * ---------------------------------------------------------------- */
    // A row where QuickBooks has more on open sales orders than on hand.
    await client.query(`UPDATE public.inventory SET qty_committed = 3 WHERE sku = 'SEA-9006' AND location = 'default'`)

    const owner = (
      await client.query(
        `SELECT sku, location, qty_on_hand, qty_committed FROM public.inventory ORDER BY sku, location`,
      )
    ).rows
    const view = await repAttempt(
      client,
      `SELECT sku, location, qty_on_hand, qty_committed, qty_available FROM public.v_inventory ORDER BY sku, location`,
    )
    const byKey = new Map(view.rows.map((r) => [`${r.sku}/${r.location}`, r]))
    const committedMismatch = owner.filter((o) => byKey.get(`${o.sku}/${o.location}`)?.qty_committed !== o.qty_committed)
    report.check(
      '2.1',
      'rep v_inventory.qty_committed equals inventory.qty_committed on every row',
      view.ok && view.rows.length === owner.length && owner.length > 0 && committedMismatch.length === 0,
      `rows owner=${owner.length} rep=${view.rows.length}; mismatched=${JSON.stringify(committedMismatch.map((o) => o.sku))}`,
    )

    const availMismatch = view.rows.filter((r) => r.qty_available !== r.qty_on_hand - r.qty_committed)
    const negative = byKey.get('SEA-9006/default')
    report.check(
      '2.2',
      'qty_available = on_hand - committed on every row, negative values not clamped',
      view.ok && availMismatch.length === 0 && negative?.qty_available === -2,
      `mismatched=${JSON.stringify(availMismatch.map((r) => r.sku))}; SEA-9006 available=${negative?.qty_available} (expected -2)`,
    )

    /* ---------------------------------------------------------------- *
     * 2.3 — a sync moves committed and available.
     * ---------------------------------------------------------------- */
    const sync23 = await applySyncAs(client, ADMIN_UID, { rows: [sourceRow('SEA-9007', 40, 25)] })
    const after23 = await repAttempt(
      client,
      `SELECT qty_on_hand, qty_committed, qty_available FROM public.v_inventory WHERE sku = 'SEA-9007' AND location = 'default'`,
    )
    const r23 = after23.rows[0]
    report.check(
      '2.3',
      'admin sync with committed 10 -> 25 shows committed 25, available 15 to a rep',
      sync23.ok && r23?.qty_on_hand === 40 && r23?.qty_committed === 25 && r23?.qty_available === 15,
      `sync ok=${sync23.ok} ${sync23.code ?? ''}; rep sees ${JSON.stringify(r23)}`,
    )

    /* ---------------------------------------------------------------- *
     * 2.4 — the portal commitment RPC is gone, for everyone.
     * ---------------------------------------------------------------- */
    const rpcRep = await repAttempt(client, `SELECT public.record_commitment('SEA-9007', 1, 'default', NULL)`)
    const rpcAdmin = await adminAttempt(client, `SELECT public.record_commitment('SEA-9007', 1, 'default', NULL)`)
    report.check(
      '2.4',
      'record_commitment does not exist for rep or admin (42883)',
      !rpcRep.ok && rpcRep.code === '42883' && !rpcAdmin.ok && rpcAdmin.code === '42883',
      `rep=${rpcRep.code} admin=${rpcAdmin.code}`,
    )

    /* ---------------------------------------------------------------- *
     * 2.5 — commitments is history: no client write of any kind.
     * ---------------------------------------------------------------- */
    const writes = [
      [`INSERT INTO public.commitments (sku, location, qty, rep_id, state) VALUES ('SEA-9007', 'default', 1, auth.uid(), 'pending')`, 'INSERT'],
      [`UPDATE public.commitments SET note = 'x'`, 'UPDATE'],
      [`DELETE FROM public.commitments`, 'DELETE'],
    ]
    const outcomes = []
    for (const [sql, verb] of writes) {
      outcomes.push({ who: 'rep', verb, ...(await repAttempt(client, sql)) })
      outcomes.push({ who: 'admin', verb, ...(await adminAttempt(client, sql)) })
    }
    const notRefused = outcomes.filter((o) => o.ok || o.code !== '42501')
    report.check(
      '2.5',
      'INSERT, UPDATE and DELETE on commitments refused (42501) for rep and admin',
      notRefused.length === 0,
      notRefused.length
        ? `not refused: ${JSON.stringify(notRefused.map((o) => `${o.who} ${o.verb} ${o.code ?? 'ok'}`))}`
        : 'all six refused with 42501',
    )

    /* ---------------------------------------------------------------- *
     * 2.6 — a stale caller sending commitment matches fails loudly.
     * ---------------------------------------------------------------- */
    const stale = await applySyncAs(client, ADMIN_UID, {
      rows: [],
      matches: [{ commitment_id: '00000000-0000-4000-8000-0000000000ff', sku: 'SEA-9007', location: 'default', qty: 1 }],
    })
    report.check(
      '2.6',
      'apply_inventory_sync with a non-empty matches array is refused (KY016)',
      !stale.ok && stale.code === 'KY016',
      `ok=${stale.ok} code=${stale.code}`,
    )

    /* ---------------------------------------------------------------- *
     * 2.7 — only an admin applies a sync.
     * ---------------------------------------------------------------- */
    const repSync = await repAttempt(
      client,
      `SELECT public.apply_inventory_sync($1::jsonb)`,
      [JSON.stringify({ rows: [sourceRow('SEA-9007', 999, 0)] })],
    )
    const unchanged27 = await ownerRow(client, 'SEA-9007')
    report.check(
      '2.7',
      'rep apply_inventory_sync refused (KY003), row unchanged',
      !repSync.ok && repSync.code === 'KY003' && unchanged27.qty_on_hand === 40 && unchanged27.qty_committed === 25,
      `code=${repSync.code}; SEA-9007 on_hand=${unchanged27.qty_on_hand} committed=${unchanged27.qty_committed}`,
    )

    /* ---------------------------------------------------------------- *
     * 2.8 / 2.8b — override survives, committed flows, attribution holds.
     * ---------------------------------------------------------------- */
    await client.query(
      `INSERT INTO auth.users (id, email) VALUES ($1, 'admin2.verify@example.invalid') ON CONFLICT (id) DO NOTHING`,
      [ADMIN2_UID],
    )
    await client.query(
      `INSERT INTO public.profiles (id, email, role) VALUES ($1, 'admin2.verify@example.invalid', 'admin')
       ON CONFLICT (id) DO UPDATE SET role = 'admin'`,
      [ADMIN2_UID],
    )

    // Admin 1 corrects SEA-9005's on-hand (64 -> 50) as a manual override.
    await asAdmin(
      client,
      (c) =>
        c.query(
          `UPDATE public.inventory
              SET qty_on_hand = 50, source = 'manual_override',
                  override_note = 'cycle count', override_at = now()
            WHERE sku = 'SEA-9005' AND location = 'default'`,
        ),
      { commit: true },
    )
    const corrected = await ownerRow(client, 'SEA-9005')
    // Distinct timestamps: a re-stamp during the sync below must be observable.
    await client.query(`SELECT pg_sleep(0.05)`)

    // Admin 2 runs a sync in which QuickBooks reports 70 on hand and 30 committed.
    const sync28 = await applySyncAs(client, ADMIN2_UID, { rows: [sourceRow('SEA-9005', 70, 30)] })
    const after28 = await ownerRow(client, 'SEA-9005')
    report.check(
      '2.8',
      "sync by another admin: override on-hand kept, committed from source, original author and time kept",
      sync28.ok &&
        corrected.override_by === ADMIN_UID &&
        after28.source === 'manual_override' &&
        after28.qty_on_hand === 50 &&
        after28.qty_committed === 30 &&
        after28.override_by === ADMIN_UID &&
        after28.override_at?.getTime() === corrected.override_at?.getTime(),
      `before by=${corrected.override_by} at=${corrected.override_at?.toISOString()}; ` +
        `after on_hand=${after28.qty_on_hand} committed=${after28.qty_committed} by=${after28.override_by} at=${after28.override_at?.toISOString()}; sync ok=${sync28.ok} ${sync28.code ?? ''}`,
    )

    // Admin 2 tries to claim the correction with an attribution-only update.
    const claim = await attempt(
      client,
      'authenticated',
      ADMIN2_UID,
      `UPDATE public.inventory SET override_by = $1 WHERE sku = 'SEA-9005' AND location = 'default'
       RETURNING override_by, override_at`,
      [ADMIN2_UID],
    )
    report.check(
      '2.8b',
      'an attribution-only update cannot rewrite who made the correction',
      claim.ok &&
        claim.rows[0]?.override_by === ADMIN_UID &&
        claim.rows[0]?.override_at?.getTime() === corrected.override_at?.getTime(),
      `ok=${claim.ok} code=${claim.code ?? ''} returned ${JSON.stringify(claim.rows[0] ?? null)}`,
    )

    /* ---------------------------------------------------------------- *
     * 2.9 — no portal INSERT can enter a committed figure.
     * ---------------------------------------------------------------- */
    await client.query(
      `INSERT INTO public.products (sku, name, category, uom, low_stock_threshold)
       VALUES ('KYV-T29', 'Verify insert product', 'Verify', 'EA', 1) ON CONFLICT (sku) DO NOTHING`,
    )
    const withCommitted = await adminAttempt(
      client,
      `INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed) VALUES ('KYV-T29', 'default', 5, 2)`,
    )
    const withoutCommitted = await adminAttempt(
      client,
      `INSERT INTO public.inventory (sku, location, qty_on_hand) VALUES ('KYV-T29', 'default', 5)
       RETURNING qty_committed`,
    )
    report.check(
      '2.9',
      'admin INSERT naming qty_committed refused (42501); the same INSERT without it succeeds at committed 0',
      !withCommitted.ok &&
        withCommitted.code === '42501' &&
        withoutCommitted.ok &&
        withoutCommitted.rows[0]?.qty_committed === 0,
      `with committed: ${withCommitted.code ?? 'ok'}; without: ${withoutCommitted.ok ? `ok committed=${withoutCommitted.rows[0]?.qty_committed}` : withoutCommitted.code}`,
    )
  } catch (err) {
    report.fail('2.!', 'attack 2 aborted', err.stack ?? err.message)
  } finally {
    await client.end()
  }

  return report
}

