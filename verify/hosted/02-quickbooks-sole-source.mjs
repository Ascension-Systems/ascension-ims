/**
 * ATTACK 2 (hosted) — QuickBooks is the only source of "committed".
 *
 * The hosted counterpart of verify/02-quickbooks-sole-source.mjs, issued over HTTPS at
 * PostgREST with real GoTrue-signed sessions. Replaces the portal-commitment attacks (old 2
 * "concurrent commitment on the last unit", old 3 "delta survives a stale baseline"), retired
 * with migration 0025. Every write is confined to the KYV namespace.
 *
 * Differences from the local runner, stated rather than hidden:
 *   * 2.4 accepts PostgREST's PGRST202 ("function not found in the schema cache") as well as
 *     42883 — over this channel a dropped function is reported by PostgREST, not Postgres.
 *   * 2.8 has one admin session to work with, so "a different user" is the rep: the override
 *     fixture is pre-attributed to the rep by service_role, and the ADMIN runs the sync. The
 *     property asserted is the same — a sync never re-credits a correction to whoever ran it.
 */

import { Report } from '../lib/report.mjs'
import { selectRows, insertRows, updateRows, deleteRows, rpc } from './lib/client.mjs'
import {
  KYV_LOCATION,
  SKU,
  OVERRIDE_SOURCE_ROW,
  resetFixtures,
  rawInventoryRow,
  applySync,
} from './lib/fixtures.mjs'

const METHOD = `figures are read through v_inventory with the rep session and compared with a
service-role read of the inventory table; syncs are applied through the
apply_inventory_sync RPC with the admin session; every forbidden action is
issued directly at PostgREST and asserted by its error code; attribution is
compared before and after a sync run by a user other than the author.`

const q = encodeURIComponent
const scope = `location=eq.${q(KYV_LOCATION)}&sku=like.KYV-*`
const time = (v) => (v ? new Date(v).getTime() : null)

const sourceRow = (sku, onHand, committed) => ({
  sku,
  location: KYV_LOCATION,
  qty_on_hand: onHand,
  qty_committed: committed,
  qty_incoming: 0,
  incoming_eta: null,
  source: 'quickbooks_stub',
})

export default async function attack2(ctx) {
  const { cfg, identities, uids } = ctx
  const report = new Report(2, 'QuickBooks is the only source of committed', METHOD)

  await resetFixtures(cfg, identities)

  /* ---------------------------------------------------------------- *
   * 2.1 / 2.2 — the rep's figures are the source's figures.
   * ---------------------------------------------------------------- */
  // QuickBooks has more on open sales orders than on hand.
  await updateRows(cfg, identities.service, 'inventory', `sku=eq.${q(SKU.CONT1)}&location=eq.${q(KYV_LOCATION)}`, {
    qty_committed: 3,
  })

  const owner = await selectRows(cfg, identities.service, 'inventory', `select=sku,qty_on_hand,qty_committed&${scope}&order=sku`)
  const view = await selectRows(
    cfg,
    identities.rep,
    'v_inventory',
    `select=sku,qty_on_hand,qty_committed,qty_available&${scope}&order=sku`,
  )
  const bySku = new Map((view.rows ?? []).map((r) => [r.sku, r]))
  const committedMismatch = (owner.rows ?? []).filter((o) => bySku.get(o.sku)?.qty_committed !== o.qty_committed)
  report.check(
    '2.1',
    'rep v_inventory.qty_committed equals inventory.qty_committed on every KYV row',
    owner.ok && view.ok && owner.rowCount > 0 && view.rowCount === owner.rowCount && committedMismatch.length === 0,
    `owner ${owner.ok ? owner.rowCount : owner.code} rows, rep ${view.ok ? view.rowCount : view.code}; mismatched ${JSON.stringify(committedMismatch.map((o) => o.sku))}`,
  )

  const availMismatch = (view.rows ?? []).filter((r) => r.qty_available !== r.qty_on_hand - r.qty_committed)
  const negative = bySku.get(SKU.CONT1)
  report.check(
    '2.2',
    'qty_available = on_hand - committed on every row, negative values not clamped',
    view.ok && availMismatch.length === 0 && negative?.qty_available === -2,
    `mismatched ${JSON.stringify(availMismatch.map((r) => r.sku))}; ${SKU.CONT1} available=${negative?.qty_available} (expected -2)`,
  )

  /* ---------------------------------------------------------------- *
   * 2.3 — a sync moves committed and available.
   * ---------------------------------------------------------------- */
  const sync23 = await applySync(cfg, identities.admin, { rows: [sourceRow(SKU.DLT, 40, 25)] })
  const after23 = await selectRows(
    cfg,
    identities.rep,
    'v_inventory',
    `select=qty_on_hand,qty_committed,qty_available&sku=eq.${q(SKU.DLT)}&location=eq.${q(KYV_LOCATION)}`,
  )
  const r23 = after23.rows?.[0]
  report.check(
    '2.3',
    'admin sync with committed 10 -> 25 shows committed 25, available 15 to a rep',
    sync23.ok && r23?.qty_on_hand === 40 && r23?.qty_committed === 25 && r23?.qty_available === 15,
    `sync ${sync23.ok ? 'ok' : `${sync23.code} ${sync23.message}`}; rep sees ${JSON.stringify(r23 ?? null)}`,
  )

  /* ---------------------------------------------------------------- *
   * 2.4 — the portal commitment RPC is gone.
   * ---------------------------------------------------------------- */
  const args = { p_sku: SKU.DLT, p_qty: 1, p_location: KYV_LOCATION, p_note: null }
  const rpcRep = await rpc(cfg, identities.rep, 'record_commitment', args)
  const rpcAdmin = await rpc(cfg, identities.admin, 'record_commitment', args)
  const gone = (r) => !r.ok && (r.code === 'PGRST202' || r.code === '42883')
  report.check(
    '2.4',
    'record_commitment does not exist for rep or admin (PGRST202 / 42883)',
    gone(rpcRep) && gone(rpcAdmin),
    `rep=${rpcRep.ok ? 'ok' : rpcRep.code} admin=${rpcAdmin.ok ? 'ok' : rpcAdmin.code}`,
  )

  /* ---------------------------------------------------------------- *
   * 2.5 — commitments is history: no client write of any kind.
   * ---------------------------------------------------------------- */
  const outcomes = []
  for (const [who, identity, uid] of [
    ['rep', identities.rep, uids.rep],
    ['admin', identities.admin, uids.admin],
  ]) {
    outcomes.push({
      who,
      verb: 'INSERT',
      ...(await insertRows(cfg, identity, 'commitments', [
        { sku: SKU.DLT, location: KYV_LOCATION, qty: 1, rep_id: uid, state: 'pending' },
      ])),
    })
    outcomes.push({ who, verb: 'UPDATE', ...(await updateRows(cfg, identity, 'commitments', scope, { note: 'x' })) })
    outcomes.push({ who, verb: 'DELETE', ...(await deleteRows(cfg, identity, 'commitments', scope)) })
  }
  const notRefused = outcomes.filter((o) => o.ok || o.code !== '42501')
  report.check(
    '2.5',
    'INSERT, UPDATE and DELETE on commitments refused (42501) for rep and admin',
    notRefused.length === 0,
    notRefused.length
      ? `not refused: ${JSON.stringify(notRefused.map((o) => `${o.who} ${o.verb} ${o.ok ? 'ok' : o.code}`))}`
      : 'all six refused with 42501',
  )

  /* ---------------------------------------------------------------- *
   * 2.6 — a stale caller sending commitment matches fails loudly.
   * ---------------------------------------------------------------- */
  const stale = await applySync(cfg, identities.admin, {
    rows: [],
    matches: [{ commitment_id: '00000000-0000-4000-8000-0000000000ff', sku: SKU.DLT, location: KYV_LOCATION, qty: 1 }],
  })
  report.check(
    '2.6',
    'apply_inventory_sync with a non-empty matches array is refused (KY016)',
    !stale.ok && stale.code === 'KY016',
    stale.ok ? 'the sync SUCCEEDED' : `code=${stale.code}`,
  )

  /* ---------------------------------------------------------------- *
   * 2.7 — only an admin applies a sync.
   * ---------------------------------------------------------------- */
  const repSync = await applySync(cfg, identities.rep, { rows: [sourceRow(SKU.DLT, 999, 0)] })
  const r27 = await rawInventoryRow(cfg, identities, SKU.DLT)
  report.check(
    '2.7',
    'rep apply_inventory_sync refused (KY003), row unchanged',
    !repSync.ok && repSync.code === 'KY003' && r27?.qty_on_hand === 40 && r27?.qty_committed === 25,
    `code=${repSync.ok ? 'ok' : repSync.code}; ${SKU.DLT} on_hand=${r27?.qty_on_hand} committed=${r27?.qty_committed}`,
  )

  /* ---------------------------------------------------------------- *
   * 2.8 / 2.8b — override survives, committed flows, attribution holds.
   * ---------------------------------------------------------------- */
  // service_role has no auth.uid(), so the attribution trigger leaves this value as supplied.
  await updateRows(cfg, identities.service, 'inventory', `sku=eq.${q(SKU.OVR)}&location=eq.${q(KYV_LOCATION)}`, {
    override_by: uids.rep,
  })
  const before28 = await rawInventoryRow(cfg, identities, SKU.OVR)

  const sync28 = await applySync(cfg, identities.admin, { rows: [{ ...OVERRIDE_SOURCE_ROW, qty_committed: 9 }] })
  const after28 = await rawInventoryRow(cfg, identities, SKU.OVR)
  report.check(
    '2.8',
    'sync by another user: override on-hand kept, committed from source, original author and time kept',
    sync28.ok &&
      before28?.override_by === uids.rep &&
      after28?.source === 'manual_override' &&
      after28?.qty_on_hand === before28?.qty_on_hand &&
      after28?.qty_committed === 9 &&
      after28?.override_by === uids.rep &&
      time(after28?.override_at) === time(before28?.override_at),
    `before on_hand=${before28?.qty_on_hand} by=${before28?.override_by} at=${before28?.override_at}; ` +
      `after on_hand=${after28?.qty_on_hand} committed=${after28?.qty_committed} by=${after28?.override_by} at=${after28?.override_at}; ` +
      `sync ${sync28.ok ? 'ok' : `${sync28.code} ${sync28.message}`}`,
  )

  const claim = await updateRows(
    cfg,
    identities.admin,
    'inventory',
    `sku=eq.${q(SKU.OVR)}&location=eq.${q(KYV_LOCATION)}`,
    { override_by: uids.admin },
  )
  const after28b = await rawInventoryRow(cfg, identities, SKU.OVR)
  report.check(
    '2.8b',
    'an attribution-only update cannot rewrite who made the correction',
    claim.ok && after28b?.override_by === uids.rep && time(after28b?.override_at) === time(before28?.override_at),
    `update ${claim.ok ? 'ok' : claim.code}; override_by=${after28b?.override_by} at=${after28b?.override_at}`,
  )

  /* ---------------------------------------------------------------- *
   * 2.9 — no portal INSERT can enter a committed figure.
   * ---------------------------------------------------------------- */
  const sku29 = 'KYV-0008'
  await insertRows(cfg, identities.service, 'products', [
    { sku: sku29, name: 'KYV verification artefact 0008 - insert target', category: 'KYV verification artefact', uom: 'EA', low_stock_threshold: 5 },
  ])
  const withCommitted = await insertRows(cfg, identities.admin, 'inventory', [
    { sku: sku29, location: KYV_LOCATION, qty_on_hand: 5, qty_committed: 2 },
  ])
  const withoutCommitted = await insertRows(cfg, identities.admin, 'inventory', [
    { sku: sku29, location: KYV_LOCATION, qty_on_hand: 5 },
  ])
  report.check(
    '2.9',
    'admin INSERT naming qty_committed refused (42501); the same INSERT without it succeeds at committed 0',
    !withCommitted.ok &&
      withCommitted.code === '42501' &&
      withoutCommitted.ok &&
      withoutCommitted.rows?.[0]?.qty_committed === 0,
    `with committed: ${withCommitted.ok ? 'ok' : withCommitted.code}; without: ${withoutCommitted.ok ? `ok committed=${withoutCommitted.rows?.[0]?.qty_committed}` : withoutCommitted.code}`,
  )

  return report
}
