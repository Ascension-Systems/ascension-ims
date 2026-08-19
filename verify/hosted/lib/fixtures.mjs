/**
 * The KYV namespace — how this harness bounds its destructiveness on a live client project.
 *
 * ------------------------------------------------------------------------------------
 * READ THIS BEFORE PORTING ANY MORE ASSERTIONS FROM THE LOCAL HARNESS.
 * ------------------------------------------------------------------------------------
 * Against embedded Postgres every destructive statement ran inside a transaction that
 * `attempt()` rolled back. OVER POSTGREST THERE IS NO ROLLBACK — EVERY REQUEST COMMITS.
 *
 * Ported literally onto the hosted project, the existing admin-control assertions would
 * permanently set SEA-9006.qty_on_hand to 9999 (1.5b), permanently DELETE the SEA-9006
 * inventory row (1.7b), set SEA-9007.qty_on_hand to 4000 (4.12a) and flip
 * app_settings.inventory_authority to 'portal' for the whole live portal (4.12b). That is
 * data loss on a client's project, dressed as verification.
 *
 * THE RULE: every hosted statement that writes targets either
 *   (a) a harness-owned disposable row in the KYV namespace, or
 *   (b) app_settings, written back to its own current value.
 * No SEA-* row is mutated. SEA-9001..SEA-9007 and the demo delta are READ-ONLY here.
 *
 * This weakens nothing. RLS policies are table-scoped, not SKU-scoped: proving
 * `inventory_update_admin` on KYV-0001 is exactly as strong as proving it on SEA-9007, and
 * it is more deterministic because it does not depend on the hosted project's current state.
 *
 * ------------------------------------------------------------------------------------
 * WHY THE SKUS ARE `KYV-0001` AND NOT `KYV-INV-0001`
 * ------------------------------------------------------------------------------------
 * `supabase/migrations/0003_products.sql:11` constrains every sku to
 * `^[A-Z]{3}-[0-9]{4}$`. Three letters, a hyphen, four digits — no longer forms are legal.
 * The `KYV-` prefix survives intact, so `sku LIKE 'KYV-%'` remains the single teardown
 * predicate; only the descriptive middle segment could not exist. The mapping is spelled out
 * in the table below so an assertion is still readable against its purpose.
 *
 * `location = 'kyv-verify'` is legal free text: 0004_inventory.sql:6 is
 * `text NOT NULL DEFAULT 'default'` with no CHECK constraint.
 *
 * `inventory.sku REFERENCES products(sku) ON DELETE CASCADE`, so each fixture needs a
 * products row first — and deleting the products row is what removes the inventory row.
 * `commitments_pending_idx` is a PLAIN index, not unique (0005_commitments.sql:34-35), so
 * multiple pending commitments per (sku, location) are permitted and the 3-unit swarm
 * assertion holds.
 */

import { selectRows, insertRows, deleteRows, countRows, rest } from './client.mjs'

export const KYV_LOCATION = 'kyv-verify'

/** A second location, reachable only by an assertion that must be REFUSED (1.6). */
export const KYV_LOCATION_ALT = 'kyv-verify-2'

/**
 * | constant | sku       | shape                                   | used by                    |
 * |----------|-----------|-----------------------------------------|----------------------------|
 * | INV      | KYV-0001  | on hand 100, committed 0                | 1.5, 1.5b, 1.6, 4.1, 4.12a |
 * | DEL      | KYV-0002  | on hand 5 — created to be destroyed     | 1.7, 1.7b, 4.3             |
 * | GEN      | KYV-0003  | 200 on hand / 186 committed -> 14 avail | attack 1 setup commitments |
 * | CONT1    | KYV-0004  | on hand 1 -> available exactly 1        | 2b 1-unit swarm, 2a.10     |
 * | CONT3    | KYV-0005  | on hand 3 -> available 3                | 2b 3-unit swarm            |
 * | DLT      | KYV-0006  | 40 on hand / 10 committed -> 30 avail   | attack 3                   |
 * | OVR      | KYV-0007  | manual_override contradicting the source| 3.11                       |
 */
export const SKU = {
  INV: 'KYV-0001',
  DEL: 'KYV-0002',
  GEN: 'KYV-0003',
  CONT1: 'KYV-0004',
  CONT3: 'KYV-0005',
  DLT: 'KYV-0006',
  OVR: 'KYV-0007',
}

/** Used by 4.2, which must be refused. Never created deliberately; teardown covers it. */
export const SKU_FORBIDDEN_INSERT = 'KYV-9999'

export const ALL_SKUS = Object.values(SKU)

const PRODUCTS = [
  [SKU.INV, 'KYV verification artefact 0001 - inventory write target'],
  [SKU.DEL, 'KYV verification artefact 0002 - delete target'],
  [SKU.GEN, 'KYV verification artefact 0003 - commitment ownership'],
  [SKU.CONT1, 'KYV verification artefact 0004 - contended, one unit'],
  [SKU.CONT3, 'KYV verification artefact 0005 - contended, three units'],
  [SKU.DLT, 'KYV verification artefact 0006 - delta ledger baseline'],
  [SKU.OVR, 'KYV verification artefact 0007 - manual override'],
].map(([sku, name]) => ({
  sku,
  name,
  category: 'KYV verification artefact',
  uom: 'EA',
  low_stock_threshold: 5,
}))

const INVENTORY = [
  { sku: SKU.INV, qty_on_hand: 100, qty_committed: 0 },
  { sku: SKU.DEL, qty_on_hand: 5, qty_committed: 0 },
  { sku: SKU.GEN, qty_on_hand: 200, qty_committed: 186 },
  { sku: SKU.CONT1, qty_on_hand: 1, qty_committed: 0 },
  { sku: SKU.CONT3, qty_on_hand: 3, qty_committed: 0 },
  { sku: SKU.DLT, qty_on_hand: 40, qty_committed: 10 },
].map((row) => ({
  ...row,
  location: KYV_LOCATION,
  qty_incoming: 0,
  incoming_eta: null,
  source: 'quickbooks_stub',
  source_payload: { kyv_verification_artefact: true },
}))

/**
 * The override fixture. `inventory_override_is_attributed` (0004:30) requires override_note
 * and override_at to be NOT NULL whenever source is 'manual_override', so both are set.
 * override_by is left NULL deliberately: pointing it at a test profile would be a second
 * artefact to unpick, and nothing asserts on it.
 */
const OVERRIDE_ROW = {
  sku: SKU.OVR,
  location: KYV_LOCATION,
  qty_on_hand: 48,
  qty_committed: 6,
  qty_incoming: 0,
  incoming_eta: null,
  source: 'manual_override',
  source_payload: {
    kyv_verification_artefact: true,
    last_source_snapshot: null,
  },
  override_note:
    'KYV verification artefact. Physical count contradicts the source figure; the harness ' +
    'asserts the sync preserves this row rather than overwriting it.',
  override_at: new Date().toISOString(),
}

/** The source row 3.11 feeds the sync — deliberately contradicting the override above. */
export const OVERRIDE_SOURCE_ROW = {
  sku: SKU.OVR,
  location: KYV_LOCATION,
  qty_on_hand: 60,
  qty_committed: 6,
  qty_incoming: 0,
  incoming_eta: null,
  source: 'quickbooks_stub',
}

/* ==================================================================== *
 * Teardown and creation
 * ==================================================================== */

const q = encodeURIComponent

/**
 * Removes everything the harness owns, in the order the foreign keys require.
 *
 * `commitments.rep_id REFERENCES profiles(id) ON DELETE RESTRICT` and
 * `commitments (sku, location) REFERENCES inventory (sku, location) ON DELETE RESTRICT`
 * both block a naive teardown, so commitments go first. Deleting the products row cascades
 * its inventory rows at EVERY location, which is what sweeps up KYV-9999 and the
 * `kyv-verify-2` row if an assertion that should have been refused ever succeeds.
 *
 * Scoped by location and by the KYV- prefix. It cannot touch a SEA-* row or the demo delta.
 */
export async function teardownFixtures(cfg, identities) {
  const svc = identities.service
  const removed = { commitments: 0, products: 0 }

  const c = await deleteRows(cfg, svc, 'commitments', `location=eq.${q(KYV_LOCATION)}`)
  if (!c.ok) throw new Error(`teardown: could not delete kyv-verify commitments: ${c.code} ${c.message}`)
  removed.commitments += c.rowCount

  const c2 = await deleteRows(cfg, svc, 'commitments', `location=eq.${q(KYV_LOCATION_ALT)}`)
  if (c2.ok) removed.commitments += c2.rowCount

  const p = await deleteRows(cfg, svc, 'products', 'sku=like.KYV-*')
  if (!p.ok) throw new Error(`teardown: could not delete KYV- products: ${p.code} ${p.message}`)
  removed.products += p.rowCount

  return removed
}

/**
 * Full reset. Every attack calls this at its start so the four are independent of one
 * another and of their own ordering — the same reason the local harness calls bootstrap().
 */
export async function resetFixtures(cfg, identities) {
  await teardownFixtures(cfg, identities)

  const svc = identities.service

  const prod = await insertRows(cfg, svc, 'products', PRODUCTS)
  if (!prod.ok) throw new Error(`fixtures: could not create KYV products: ${prod.code} ${prod.message}`)

  const inv = await insertRows(cfg, svc, 'inventory', [...INVENTORY, OVERRIDE_ROW])
  if (!inv.ok) throw new Error(`fixtures: could not create KYV inventory: ${inv.code} ${inv.message}`)

  return { products: prod.rowCount, inventory: inv.rowCount }
}

/** Re-reads a fixture inventory row as service-role. Used to prove a write did not land. */
export async function rawInventoryRow(cfg, identities, sku, location = KYV_LOCATION) {
  const res = await selectRows(
    cfg,
    identities.service,
    'inventory',
    `select=*&sku=eq.${q(sku)}&location=eq.${q(location)}`,
  )
  return res.ok ? (res.rows[0] ?? null) : null
}

/**
 * Pending commitment count for one fixture, service-role, scoped to the KYV namespace.
 *
 * Counted with `Prefer: count=exact` (PostgREST's Content-Range) rather than by measuring a
 * returned array. A row payload is subject to whatever `max-rows` the deployment configures,
 * and a silently truncated array would turn a wrong count into a confident assertion.
 */
export async function pendingCount(cfg, identities, sku, location = KYV_LOCATION) {
  const res = await countRows(
    cfg,
    identities.service,
    'commitments',
    `sku=eq.${q(sku)}&location=eq.${q(location)}&state=eq.pending`,
  )
  return res.ok ? res.count : null
}

/**
 * Project-wide pending commitment count.
 *
 * Needed because `apply_inventory_sync` computes `commitments_still_pending` as
 * `SELECT count(*) FROM public.commitments WHERE state = 'pending'`
 * (0010_fn_apply_inventory_sync.sql:148) — GLOBAL, not scoped to the payload. On a hosted
 * project the demo delta and any prior harness rows inflate it, so assertions on that field
 * are made as DELTAS against this figure rather than as absolutes.
 */
export async function globalPendingCount(cfg, identities) {
  const res = await countRows(cfg, identities.service, 'commitments', 'state=eq.pending')
  return res.ok ? res.count : null
}

/** Records a commitment through the RPC as a given identity. */
export async function recordCommitment(cfg, identity, sku, qty, note = null, location = KYV_LOCATION) {
  const res = await rest(cfg, identity, 'POST', '/rpc/record_commitment', {
    body: { p_sku: sku, p_qty: qty, p_location: location, p_note: note },
  })
  return res
}

/** Runs apply_inventory_sync through the RPC as a given identity. */
export async function applySync(cfg, identity, payload) {
  return rest(cfg, identity, 'POST', '/rpc/apply_inventory_sync', { body: { p_payload: payload } })
}

/** The disclosure printed in the run banner and repeated in the summary. */
export const ARTEFACT_DISCLOSURE = [
  'THIS RUN WRITES TO THE LIVE PROJECT. Per full run it creates and deletes roughly 7',
  'products prefixed KYV-, 7 inventory rows at location \'kyv-verify\', on the order of 45',
  'commitment rows and around a dozen inventory_sync_runs rows. It touches app_settings only',
  'by writing its current value back to itself. It does NOT modify any SEA-* seed row or the',
  'demo delta. While the artefacts exist they are visible in the application\'s inventory',
  'list under the category "KYV verification artefact". If the harness is killed mid-run the',
  'KYV rows and the test identities survive; `npm run verify:identities:remove` is the remedy.',
]
