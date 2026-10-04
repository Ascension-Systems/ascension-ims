/**
 * ATTACK 1 — RLS bypass, against the hosted project over PostgREST.
 *
 * Method: a real, GoTrue-signed rep session issues every read and write DIRECTLY at
 * PostgREST, not through the UI. An admin-session control run confirms the forbidden rows
 * actually exist, so a refusal is distinguished from an empty table.
 *
 * A pass requires demonstrating the REFUSAL, not the absence of a UI button.
 *
 * ------------------------------------------------------------------------------------
 * ON RLS-FILTERED UPDATE/DELETE — "NO ERROR AND 0 ROWS" IS NOT ACCEPTED HERE
 * ------------------------------------------------------------------------------------
 * Postgres does not raise on an UPDATE or DELETE that an RLS USING clause filters out: the
 * rows are invisible to the statement, so it reports 0 rows and no error. 42501 is raised
 * for INSERT (a WITH CHECK violation) and for any command the role lacks the table GRANT
 * for — which is why every write to `commitments` does raise.
 *
 * For each filtered write this file asserts three things together:
 *   (a) the statement affected 0 rows,
 *   (b) the target row is unchanged on an independent service-role re-read, and
 *   (c) the IDENTICAL statement, run as admin, affects >= 1 row.
 * (c) is what makes it a demonstration of the policy rather than of a broken statement or
 * of a blanket denial.
 *
 * 1.12 is the one assertion in this file that cannot run over this channel: `pg_class` is
 * not exposed by PostgREST. It is restated as a labelled STATIC check of the migration
 * source and is never reported as a live database result. The deployed-view check runs only
 * under `npm run verify:local`.
 */

import { Report } from '../lib/report.mjs'
import { latestViewDefinition } from './lib/migration-source.mjs'
import { selectRows, insertRows, updateRows, deleteRows } from './lib/client.mjs'
import {
  KYV_LOCATION,
  KYV_LOCATION_ALT,
  SKU,
  resetFixtures,
  rawInventoryRow,
  seedHistoricalCommitment,
  applySync,
} from './lib/fixtures.mjs'

const METHOD = `a real GoTrue-signed rep session issues every read and write directly at
PostgREST over HTTPS. An admin control run proves the forbidden rows exist.
Filtered writes are asserted three ways: 0 rows affected, target row unchanged
on an independent service-role re-read, and the same request succeeding as
admin. All writes are confined to the KYV namespace; no SEA-* row is touched.`

const q = encodeURIComponent

export default async function attack1(ctx) {
  const { cfg, identities, uids } = ctx
  const report = new Report(1, 'RLS bypass', METHOD)

  await resetFixtures(cfg, identities)

  /* ---------------------------------------------------------------- *
   * Setup: one historical commitment owned by the rep, one by the admin.
   * Seeded by service_role — since 0025 no client identity can write
   * `commitments` at all; the table is read-only history.
   * ---------------------------------------------------------------- */
  const repCommit = await seedHistoricalCommitment(cfg, identities, uids.rep, SKU.GEN, 3, 'rep commitment')
  const adminCommit = await seedHistoricalCommitment(cfg, identities, uids.admin, SKU.GEN, 2, 'admin commitment')

  if (!repCommit.ok || !adminCommit.ok) {
    report.fail(
      '1.0',
      'setup: two historical commitments seeded',
      `rep: ${repCommit.code ?? 'ok'} ${repCommit.message ?? ''} / admin: ${adminCommit.code ?? 'ok'} ${adminCommit.message ?? ''}`,
    )
    return report
  }
  const adminCommitmentId = adminCommit.rows[0]?.id

  // A sync run, so 1.3 has a real row to be refused rather than an empty table.
  await applySync(cfg, identities.admin, { rows: [] })

  /* ---------------------------------------------------------------- *
   * 1.1 — read every commitment
   * ---------------------------------------------------------------- */
  const scope = `select=id,rep_id&location=eq.${q(KYV_LOCATION)}`
  const repRows = await selectRows(cfg, identities.rep, 'commitments', scope)
  const adminRows = await selectRows(cfg, identities.admin, 'commitments', scope)

  report.check(
    '1.1',
    'rep SELECT commitments returns only own rows',
    repRows.ok && repRows.rowCount === 1 && repRows.rows.every((r) => r.rep_id === uids.rep),
    `rep saw ${repRows.rowCount} row(s) ${JSON.stringify(repRows.rows.map((r) => r.rep_id))}; admin control sees ${adminRows.rowCount}`,
  )
  report.check(
    '1.1b',
    "admin control proves the other rep's row exists",
    adminRows.ok && adminRows.rowCount === 2,
    `admin saw ${adminRows.rowCount} rows, expected 2 (code ${adminRows.code ?? 'ok'})`,
  )

  /* ---------------------------------------------------------------- *
   * 1.2 — name the forbidden row directly
   * ---------------------------------------------------------------- */
  const named = await selectRows(
    cfg,
    identities.rep,
    'commitments',
    `select=*&id=eq.${q(adminCommitmentId ?? '00000000-0000-0000-0000-000000000000')}`,
  )
  report.check(
    '1.2',
    "naming another user's commitment by id returns 0 rows",
    named.ok && named.rowCount === 0,
    `returned ${named.rowCount} rows (code ${named.code ?? 'ok'})`,
  )

  /* ---------------------------------------------------------------- *
   * 1.3 — a forbidden table that is not commitments
   * ---------------------------------------------------------------- */
  const repRuns = await selectRows(cfg, identities.rep, 'inventory_sync_runs', 'select=id')
  const adminRuns = await selectRows(cfg, identities.admin, 'inventory_sync_runs', 'select=id')
  report.check(
    '1.3',
    'rep SELECT inventory_sync_runs returns 0 rows',
    repRuns.ok && repRuns.rowCount === 0,
    `returned ${repRuns.rowCount} rows (code ${repRuns.code ?? 'ok'})`,
  )
  report.check(
    '1.3b',
    'admin control returns >= 1 sync run',
    adminRuns.ok && adminRuns.rowCount >= 1,
    `admin saw ${adminRuns.rowCount} rows (code ${adminRuns.code ?? 'ok'})`,
  )

  /* ---------------------------------------------------------------- *
   * 1.4 — profiles. Real users exist on this project and are invisible.
   * ---------------------------------------------------------------- */
  const repProfiles = await selectRows(cfg, identities.rep, 'profiles', 'select=id,role')
  report.check(
    '1.4',
    'rep SELECT profiles returns exactly 1 row (own)',
    repProfiles.ok && repProfiles.rowCount === 1 && repProfiles.rows[0]?.id === uids.rep,
    `returned ${repProfiles.rowCount} rows (code ${repProfiles.code ?? 'ok'})`,
  )

  /* ---------------------------------------------------------------- *
   * 1.5 — write to inventory. KYV-0001, never SEA-9006.
   * ---------------------------------------------------------------- */
  const invFilter = `sku=eq.${q(SKU.INV)}&location=eq.${q(KYV_LOCATION)}`
  const before = await rawInventoryRow(cfg, identities, SKU.INV)
  const repUpdate = await updateRows(cfg, identities.rep, 'inventory', invFilter, {
    qty_on_hand: 9999,
  })
  const after = await rawInventoryRow(cfg, identities, SKU.INV)
  const adminUpdate = await updateRows(cfg, identities.admin, 'inventory', invFilter, {
    qty_on_hand: 9999,
  })

  report.check(
    '1.5',
    'rep UPDATE inventory affects 0 rows and leaves it unchanged',
    repUpdate.ok &&
      repUpdate.rowCount === 0 &&
      after?.qty_on_hand === before?.qty_on_hand &&
      after?.qty_on_hand === 100,
    `rowCount=${repUpdate.rowCount} code=${repUpdate.code} qty_on_hand ${before?.qty_on_hand} -> ${after?.qty_on_hand}`,
  )
  report.check(
    '1.5b',
    'admin control: the identical UPDATE affects 1 row',
    adminUpdate.ok && adminUpdate.rowCount === 1,
    `rowCount=${adminUpdate.rowCount} code=${adminUpdate.code} ${adminUpdate.message ?? ''}`,
  )

  /* ---------------------------------------------------------------- *
   * 1.6 — INSERT into inventory (WITH CHECK violation -> a real 42501).
   *       A distinct location, so a primary-key conflict cannot masquerade
   *       as the policy refusal.
   * ---------------------------------------------------------------- */
  const repInsertInv = await insertRows(cfg, identities.rep, 'inventory', [
    { sku: SKU.INV, location: KYV_LOCATION_ALT, qty_on_hand: 25 },
  ])
  report.refused('1.6', 'rep INSERT INTO inventory refused', repInsertInv, '42501')

  /* ---------------------------------------------------------------- *
   * 1.7 — DELETE from inventory. KYV-0002 exists to be destroyed.
   * ---------------------------------------------------------------- */
  const delFilter = `sku=eq.${q(SKU.DEL)}&location=eq.${q(KYV_LOCATION)}`
  const repDelete = await deleteRows(cfg, identities.rep, 'inventory', delFilter)
  const survived = await rawInventoryRow(cfg, identities, SKU.DEL)
  const adminDelete = await deleteRows(cfg, identities.admin, 'inventory', delFilter)

  report.check(
    '1.7',
    'rep DELETE FROM inventory affects 0 rows; the row survives',
    repDelete.ok && repDelete.rowCount === 0 && survived !== null,
    `rowCount=${repDelete.rowCount} code=${repDelete.code}, row ${survived ? 'survived' : 'is GONE'}`,
  )
  report.check(
    '1.7b',
    'admin control: the identical DELETE affects 1 row',
    adminDelete.ok && adminDelete.rowCount === 1,
    `rowCount=${adminDelete.rowCount} code=${adminDelete.code} ${adminDelete.message ?? ''}`,
  )

  /* ---------------------------------------------------------------- *
   * 1.8 — the one that would defeat attack 2 if it succeeded
   * ---------------------------------------------------------------- */
  const directInsert = await insertRows(cfg, identities.rep, 'commitments', [
    { sku: SKU.INV, location: KYV_LOCATION, qty: 1, rep_id: uids.rep, state: 'pending' },
  ])
  report.refused(
    '1.8',
    'rep INSERT INTO commitments directly refused (no write path exists since 0025)',
    directInsert,
    '42501',
  )

  const adminDirectInsert = await insertRows(cfg, identities.admin, 'commitments', [
    { sku: SKU.INV, location: KYV_LOCATION, qty: 1, rep_id: uids.admin, state: 'pending' },
  ])
  report.refused(
    '1.8b',
    'admin is refused the same direct INSERT (not a privilege admin has either)',
    adminDirectInsert,
    '42501',
  )

  /* ---------------------------------------------------------------- *
   * 1.9 — no UPDATE policy exists on commitments, for anyone
   * ---------------------------------------------------------------- */
  const directUpdate = await updateRows(
    cfg,
    identities.rep,
    'commitments',
    `rep_id=eq.${q(uids.rep)}`,
    { state: 'retired' },
  )
  report.refused('1.9', 'rep UPDATE commitments refused', directUpdate, '42501')

  /* ---------------------------------------------------------------- *
   * 1.10 / 1.11 — anon, holding nothing but the anon key
   * ---------------------------------------------------------------- */
  const anonView = await selectRows(cfg, identities.anon, 'v_inventory', 'select=sku&limit=1')
  report.refused('1.10', 'anon SELECT v_inventory refused', anonView, '42501')

  const anonCommitments = await selectRows(cfg, identities.anon, 'commitments', 'select=id&limit=1')
  report.refused('1.11', 'anon SELECT commitments refused', anonCommitments, '42501')

  /* ---------------------------------------------------------------- *
   * 1.12 — the view-owner bypass.
   *
   * pg_class is not reachable over PostgREST, so this is asserted against
   * the migration source and LABELLED AS SUCH. No live proxy for it exists
   * over this channel and none is invented.
   * ---------------------------------------------------------------- */
  // The LATEST definition applied (0025 drops and recreates the view), not a fixed file.
  const view = latestViewDefinition()
  const asAt = view ? view.text.search(/\bAS\s+SELECT\b/i) : -1
  const viewHeader = view && asAt > 0 ? view.text.slice(0, asAt) : ''
  report.staticCheck(
    '1.12',
    `v_inventory carries security_invoker (a default view is a full RLS bypass) — effective definition: ${view?.file ?? 'NOT FOUND'}`,
    Boolean(view) && /WITH\s*\(\s*security_invoker\s*=\s*(on|true)\s*\)/i.test(viewHeader),
    'STATIC — asserts the migration source, not the deployed view. pg_class is not exposed ' +
      'over PostgREST. The live pg_class check runs only under `npm run verify:local`.',
    `the CREATE VIEW header in supabase/migrations/0008_inventory_view.sql does not carry security_invoker: ${JSON.stringify(viewHeader)}`,
  )

  return report
}
