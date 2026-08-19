/**
 * ATTACK 3 — the delta survives a stale baseline, against the hosted project.
 *
 * This is the oversell bug the project exists to prevent: a rep commits ten chairs Monday,
 * the paperwork reaches QuickBooks Wednesday, and a Monday-night reset erases the delta so
 * the chairs look available again on Tuesday.
 *
 * Fixture: KYV-0006 at location 'kyv-verify', 40 on hand / 10 committed -> 30 available.
 * SEA-9007 and the demo delta are read-only to this file.
 *
 * ------------------------------------------------------------------------------------
 * TWO THINGS THIS FILE GETS RIGHT THAT A LITERAL PORT WOULD GET WRONG
 * ------------------------------------------------------------------------------------
 * 1. `commitments_still_pending` IS GLOBAL, NOT PAYLOAD-SCOPED.
 *    `0010_fn_apply_inventory_sync.sql:148` computes it as
 *      SELECT count(*) INTO v_unmatched FROM public.commitments WHERE state = 'pending';
 *    — the whole project, unfiltered. On a hosted project the demo delta and any prior
 *    harness rows inflate it, so 3.2c is asserted as a DELTA against a count read
 *    immediately beforehand, not as the absolute `= 1` the local harness can rely on.
 *    `commitments_confirmed`, by contrast, counts only matches confirmed in this call
 *    (v_confirmed, line 145), so it stays an absolute assertion.
 *
 * 2. AGEING NEEDS DDL, AND DDL IS UNREACHABLE.
 *    3.4/3.4b and 3.5/3.5b/3.5c assert a post-ageing state that can only be established by
 *    `ALTER TABLE ... DISABLE TRIGGER`. service_role cannot run DDL over any channel
 *    available here. Re-running 3.2 and reporting those ids as passes would be a false
 *    claim, so they are NOT EXECUTED with the reason. They run under `npm run verify:local`.
 *
 * 3.6's function-body inspection needs pg_get_functiondef, which PostgREST does not expose.
 * It is restated as a labelled STATIC grep of the migration source — the same six patterns,
 * the same block isolation — and is never reported as a live database result.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Report } from '../lib/report.mjs'
import { REPO } from './lib/config.mjs'
import { selectRows, updateRows, inventoryRow } from './lib/client.mjs'
import {
  KYV_LOCATION,
  SKU,
  OVERRIDE_SOURCE_ROW,
  resetFixtures,
  rawInventoryRow,
  recordCommitment,
  applySync,
  globalPendingCount,
} from './lib/fixtures.mjs'

const METHOD = `a rep records a commitment through the record_commitment RPC, then
apply_inventory_sync is called repeatedly over PostgREST with the SAME baseline
and an empty matches array — a source that has not caught up. Retirement is then
driven by an explicit match, and by mismatched and unknown matches, and the run
report inspected. The immutability guard is attacked with a service-role PATCH.
All writes are in the KYV namespace.`

const q = encodeURIComponent

const BASELINE = {
  sku: SKU.DLT,
  location: KYV_LOCATION,
  qty_on_hand: 40,
  qty_committed: 10,
  qty_incoming: 0,
  incoming_eta: null,
  source: 'quickbooks_stub',
}

const stateOf = async (cfg, identities, id) => {
  const res = await selectRows(
    cfg,
    identities.service,
    'commitments',
    `select=state,source_ref,confirmed_at&id=eq.${q(id)}`,
  )
  return res.ok ? (res.rows[0] ?? null) : null
}

export default async function attack3(ctx) {
  const { cfg, identities, oracle } = ctx
  const report = new Report(3, 'Delta survives a stale baseline', METHOD)

  await resetFixtures(cfg, identities)

  const start = await inventoryRow(cfg, oracle, SKU.DLT, KYV_LOCATION)
  report.equals(
    '3.0',
    `${SKU.DLT} starts at 40 on hand / 10 committed / 30 available`,
    `${start?.qty_on_hand}/${start?.qty_committed_source}/${start?.qty_available}`,
    '40/10/30',
  )

  /* ---------------------------------------------------------------- *
   * 3.1 — record the commitment
   * ---------------------------------------------------------------- */
  const commit = await recordCommitment(cfg, identities.rep, SKU.DLT, 6, 'attack 3 delta')
  if (!commit.ok) {
    report.fail('3.1', 'rep records a commitment of 6', `${commit.code}: ${commit.message}`)
    return report
  }
  const commitmentId = commit.rows[0]?.id

  let row = await inventoryRow(cfg, oracle, SKU.DLT, KYV_LOCATION)
  report.equals('3.1', 'qty_available drops 30 -> 24', row?.qty_available, 24)
  report.equals('3.1b', 'qty_committed_portal is 6', row?.qty_committed_portal, 6)
  report.equals('3.1c', 'commitment state is pending', commit.rows[0]?.state, 'pending')

  /* ---------------------------------------------------------------- *
   * 3.2 — a sync with the SAME baseline and NO matches
   * ---------------------------------------------------------------- */
  const pendingBefore = await globalPendingCount(cfg, identities)
  const sync1 = await applySync(cfg, identities.admin, { rows: [BASELINE], matches: [] })
  const report1 = sync1.body

  row = await inventoryRow(cfg, oracle, SKU.DLT, KYV_LOCATION)
  let st = await stateOf(cfg, identities, commitmentId)

  report.equals('3.2', 'commitment is still pending after a stale sync', st?.state, 'pending')
  report.equals('3.2b', 'qty_available is still 24', row?.qty_available, 24)
  report.check(
    '3.2c',
    'run report: commitments_still_pending is unchanged by a stale sync (delta = 0)',
    Number.isInteger(pendingBefore) &&
      report1?.commitments_still_pending === pendingBefore,
    `commitments_still_pending=${report1?.commitments_still_pending}, project-wide pending count read immediately before the sync=${pendingBefore}. ` +
      'This is a DELTA assertion because 0010:148 counts every pending commitment in the project, not just the payload’s.',
  )
  report.equals('3.2d', 'run report says commitments_confirmed = 0', report1?.commitments_confirmed, 0)

  /* ---------------------------------------------------------------- *
   * 3.3 — five more identical syncs. No accumulation retires it.
   * ---------------------------------------------------------------- */
  for (let i = 0; i < 5; i += 1) {
    await applySync(cfg, identities.admin, { rows: [BASELINE], matches: [] })
  }
  row = await inventoryRow(cfg, oracle, SKU.DLT, KYV_LOCATION)
  st = await stateOf(cfg, identities, commitmentId)
  report.equals('3.3', 'still pending after six syncs in total', st?.state, 'pending')
  report.equals('3.3b', 'qty_available still 24 after six syncs', row?.qty_available, 24)

  /* ---------------------------------------------------------------- *
   * 3.4a — the immutability guard, attacked with the most privileged
   *        caller this channel has.
   *
   * 0012:13 revokes table privileges from anon and authenticated ONLY, so
   * service_role retains Supabase's default ALL on public tables. That is
   * what lets the request reach the BEFORE UPDATE trigger at all. If the
   * grant is not what 0012 implies, the observation is 42501 rather than
   * KY006 — a MISSING GRANT, which is a different finding from a broken
   * trigger and must not be reported as FAIL.
   * ---------------------------------------------------------------- */
  const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const ageAttempt = await updateRows(
    cfg,
    identities.service,
    'commitments',
    `id=eq.${q(commitmentId)}`,
    { created_at: aged },
  )
  if (!ageAttempt.ok && ageAttempt.code === '42501') {
    report.notExecuted(
      '3.4a',
      'even a privileged caller cannot rewrite created_at (KY006 immutability guard)',
      'NOT EXECUTED — service_role lacks the UPDATE grant on commitments; the trigger was ' +
        'never reached (observed 42501). This is a grant finding, not a trigger finding.',
    )
  } else {
    report.refused(
      '3.4a',
      'even a privileged caller cannot rewrite created_at (KY006 immutability guard)',
      ageAttempt,
      'KY006',
    )
  }

  const NO_DDL =
    'establishing a 30-day-old commitment requires ALTER TABLE ... DISABLE TRIGGER. That is ' +
    'DDL, and DDL is unreachable over PostgREST for service_role or anyone else. Re-running ' +
    'the 3.2 sync and reporting these ids as passes would be a false claim. Runs under ' +
    '`npm run verify:local`.'

  report.notExecuted('3.4', 'a 30-day-old commitment is still pending', NO_DDL)
  report.notExecuted('3.4b', 'qty_available still 24 after ageing', NO_DDL)
  report.notExecuted('3.5', 'still pending after a sync on a 30-day-old commitment', NO_DDL)
  report.notExecuted('3.5b', 'qty_available still 24 after the post-ageing sync', NO_DDL)
  report.notExecuted('3.5c', 'run report still reports it pending after ageing', NO_DDL)

  /* ---------------------------------------------------------------- *
   * 3.6 — no elapsed-time construct in the retirement path.
   *
   * pg_get_functiondef is not exposed over PostgREST, so this asserts the
   * MIGRATION SOURCE. Same six patterns, same block isolation as the
   * deployed-body check under verify:local.
   * ---------------------------------------------------------------- */
  const STATIC_NOTE =
    'STATIC — asserts the migration source, not the deployed function. pg_get_functiondef is ' +
    'not exposed over PostgREST. The deployed-body check runs only under `npm run verify:local`.'

  const src = readFileSync(
    join(REPO, 'supabase', 'migrations', '0010_fn_apply_inventory_sync.sql'),
    'utf8',
  )
  const startIdx = src.indexOf('-- 2. Retire deltas')
  const endIdx = src.indexOf('SELECT count(*) INTO v_unmatched')
  const retirementBlock = startIdx >= 0 && endIdx > startIdx ? src.slice(startIdx, endIdx) : ''

  report.staticCheck(
    '3.6a',
    'the retirement block is locatable in the migration source',
    retirementBlock.length > 0,
    STATIC_NOTE,
    'could not isolate the retirement block from supabase/migrations/0010_fn_apply_inventory_sync.sql',
  )

  const forbidden = [
    ['interval', /\binterval\b/i],
    ['age(', /\bage\s*\(/i],
    ['now() -', /now\s*\(\s*\)\s*-/i],
    ['current_date', /\bcurrent_date\b/i],
    ['current_timestamp -', /current_timestamp\s*-/i],
    ['older_than / expires / stale', /\b(older_than|expires_at|expired|stale_after)\b/i],
  ]
  for (const [label, re] of forbidden) {
    report.staticCheck(
      `3.6 ${label}`,
      `retirement block contains no \`${label}\``,
      !re.test(retirementBlock),
      STATIC_NOTE,
      `found \`${label}\` in the retirement path`,
    )
  }

  /* ---------------------------------------------------------------- *
   * 3.7 — the structural backstop: pending -> retired in one step.
   *       Same grant conditionality as 3.4a.
   * ---------------------------------------------------------------- */
  const now = new Date().toISOString()
  const shortcut = await updateRows(
    cfg,
    identities.service,
    'commitments',
    `id=eq.${q(commitmentId)}`,
    { state: 'retired', confirmed_at: now, retired_at: now },
  )
  if (!shortcut.ok && shortcut.code === '42501') {
    report.notExecuted(
      '3.7',
      'pending -> retired refused even for a privileged caller (KY006)',
      'NOT EXECUTED — service_role lacks the UPDATE grant on commitments; the trigger was ' +
        'never reached (observed 42501). This is a grant finding, not a trigger finding.',
    )
  } else {
    report.refused(
      '3.7',
      'pending -> retired refused even for a privileged caller (KY006)',
      shortcut,
      'KY006',
    )
  }

  /* ---------------------------------------------------------------- *
   * 3.8 — a sync WITH a real match. The source has absorbed the delta.
   *       qty_available must NOT move.
   * ---------------------------------------------------------------- */
  const sync8 = await applySync(cfg, identities.admin, {
    rows: [{ ...BASELINE, qty_committed: 16 }],
    matches: [
      {
        commitment_id: commitmentId,
        sku: SKU.DLT,
        location: KYV_LOCATION,
        qty: 6,
        source_ref: 'SO-10241',
      },
    ],
  })
  row = await inventoryRow(cfg, oracle, SKU.DLT, KYV_LOCATION)
  const confirmed = await stateOf(cfg, identities, commitmentId)

  report.equals('3.8', 'commitment becomes confirmed_in_source', confirmed?.state, 'confirmed_in_source')
  report.equals('3.8b', 'source_ref is recorded', confirmed?.source_ref, 'SO-10241')
  report.check('3.8c', 'confirmed_at is set', Boolean(confirmed?.confirmed_at), 'confirmed_at is NULL')
  report.equals('3.8d', 'qty_committed_portal is back to 0', row?.qty_committed_portal, 0)
  report.equals('3.8e', 'qty_available is STILL 24 — no double count, no upward blip', row?.qty_available, 24)
  report.equals('3.8f', 'run report says commitments_confirmed = 1', sync8.body?.commitments_confirmed, 1)

  /* ---------------------------------------------------------------- *
   * 3.9 — the match names the right commitment but the wrong qty
   * ---------------------------------------------------------------- */
  const commit2 = await recordCommitment(cfg, identities.rep, SKU.DLT, 6, 'attack 3 mismatch case')
  const sync9 = await applySync(cfg, identities.admin, {
    rows: [{ ...BASELINE, qty_committed: 16 }],
    matches: [
      {
        commitment_id: commit2.rows[0]?.id,
        sku: SKU.DLT,
        location: KYV_LOCATION,
        qty: 5,
        source_ref: 'SO-10242',
      },
    ],
  })
  const state9 = await stateOf(cfg, identities, commit2.rows[0]?.id)
  const rejected9 = JSON.stringify(sync9.body?.rejected ?? [])

  report.equals('3.9', 'a qty disagreement does NOT confirm the commitment', state9?.state, 'pending')
  report.check(
    '3.9b',
    'run report records match_fields_disagree',
    rejected9.includes('match_fields_disagree'),
    `rejected = ${rejected9}`,
  )

  /* ---------------------------------------------------------------- *
   * 3.10 — unknown commitment id. Before/after comparison is scoped to
   *        the KYV namespace: the project's other commitments are none
   *        of this assertion's business.
   * ---------------------------------------------------------------- */
  const scope = `select=id,state&location=eq.${q(KYV_LOCATION)}&order=id`
  const before10 = await selectRows(cfg, identities.service, 'commitments', scope)
  const sync10 = await applySync(cfg, identities.admin, {
    rows: [],
    matches: [
      {
        commitment_id: '00000000-0000-4000-8000-0000000000ff',
        sku: SKU.DLT,
        location: KYV_LOCATION,
        qty: 6,
      },
    ],
  })
  const after10 = await selectRows(cfg, identities.service, 'commitments', scope)

  report.check(
    '3.10',
    'an unknown commitment id is reported, not acted on',
    JSON.stringify(sync10.body?.rejected ?? []).includes('unknown_commitment'),
    `rejected = ${JSON.stringify(sync10.body?.rejected ?? [])}`,
  )
  report.check(
    '3.10b',
    'no commitment in the KYV namespace was altered',
    before10.ok && after10.ok && JSON.stringify(before10.rows) === JSON.stringify(after10.rows),
    'commitment states changed during an unknown-match sync',
  )

  /* ---------------------------------------------------------------- *
   * 3.11 — override preservation. Show both numbers, never silently
   *        override.
   * ---------------------------------------------------------------- */
  const ovBefore = await inventoryRow(cfg, oracle, SKU.OVR, KYV_LOCATION)
  const sync11 = await applySync(cfg, identities.admin, {
    rows: [OVERRIDE_SOURCE_ROW],
    matches: [],
  })
  const ovAfter = await inventoryRow(cfg, oracle, SKU.OVR, KYV_LOCATION)
  const rawOv = await rawInventoryRow(cfg, identities, SKU.OVR)

  report.equals(
    '3.11',
    'override quantities are unchanged by the sync',
    `${ovAfter?.qty_on_hand}/${ovAfter?.qty_committed_source}`,
    `${ovBefore?.qty_on_hand}/${ovBefore?.qty_committed_source}`,
  )
  report.equals('3.11b', 'the row is still a manual_override', ovAfter?.source, 'manual_override')
  report.check(
    '3.11c',
    'source_payload.last_source_snapshot records what the source claimed',
    rawOv?.source_payload?.last_source_snapshot?.qty_on_hand === OVERRIDE_SOURCE_ROW.qty_on_hand,
    `last_source_snapshot = ${JSON.stringify(rawOv?.source_payload?.last_source_snapshot)}`,
  )
  report.equals('3.11d', 'run report says overrides_preserved = 1', sync11.body?.overrides_preserved, 1)
  report.equals('3.11e', 'run report says rows_applied = 0', sync11.body?.rows_applied, 0)

  report.notes = [
    'commitments_still_pending is project-wide (0010:148), so 3.2c is asserted as a delta',
    'against a count read immediately before the sync. commitments_confirmed, rows_applied and',
    'overrides_preserved are payload-scoped and are asserted absolutely.',
  ]

  return report
}
