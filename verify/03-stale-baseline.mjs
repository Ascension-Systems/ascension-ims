/**
 * ATTACK 3 — the delta survives a stale baseline.
 *
 * This is the oversell bug the project exists to prevent: a rep commits ten chairs Monday,
 * the paperwork reaches QuickBooks Wednesday, and a Monday-night reset erases the delta so
 * the chairs look available again on Tuesday.
 *
 * Fixture: SEA-9007, qty_on_hand = 40, qty_committed = 10 -> qty_available 30.
 *
 * Step 3.8 is the one most likely to be got subtly wrong: if the baseline update and the
 * state change were in separate transactions, qty_available would briefly read 30 between
 * them.
 */

import {
  Report,
  ownerClient,
  bootstrap,
  inventoryRow,
  recordCommitmentAs,
  applySyncAs,
  attempt,
  REP_UID,
  ADMIN_UID,
} from './lib/harness.mjs'

const METHOD = `a rep records a commitment through record_commitment, then apply_inventory_sync
is run repeatedly with the SAME baseline and an empty matches array — a source
that has not caught up. The commitment's created_at is then forcibly aged 30
days and the sync re-run. Retirement is finally driven by an explicit match, and
by mismatched and unknown matches, and the run report inspected. The function
body is read back from pg_get_functiondef and asserted to contain no
elapsed-time construct in its retirement block.`

const BASELINE = { sku: 'SEA-9007', location: 'default', qty_on_hand: 40, qty_committed: 10, qty_incoming: 0, incoming_eta: null, source: 'quickbooks_stub' }

export default async function attack3(db) {
  const report = new Report(3, 'Delta survives a stale baseline', METHOD)
  const client = await ownerClient(db)

  try {
    await bootstrap(db, client)

    const start = await inventoryRow(client, 'SEA-9007')
    report.equals('3.0', 'SEA-9007 starts at 40 on hand / 10 committed / 30 available', `${start.qty_on_hand}/${start.qty_committed_source}/${start.qty_available}`, '40/10/30')

    /* ---------------------------------------------------------------- *
     * 3.1 — record the commitment
     * ---------------------------------------------------------------- */
    const commit = await recordCommitmentAs(client, REP_UID, 'SEA-9007', 6, 'attack 3 delta')
    if (!commit.ok) {
      report.fail('3.1', 'rep records a commitment of 6', `${commit.code}: ${commit.message}`)
      return report
    }
    const commitmentId = commit.row.id

    let row = await inventoryRow(client, 'SEA-9007')
    report.equals('3.1', 'qty_available drops 30 -> 24', row.qty_available, 24)
    report.equals('3.1b', 'qty_committed_portal is 6', row.qty_committed_portal, 6)
    report.equals('3.1c', 'commitment state is pending', commit.row.state, 'pending')

    /* ---------------------------------------------------------------- *
     * 3.2 — a sync with the SAME baseline and NO matches
     * ---------------------------------------------------------------- */
    const sync1 = await applySyncAs(client, ADMIN_UID, { rows: [BASELINE], matches: [] })
    row = await inventoryRow(client, 'SEA-9007')
    let state = (await client.query('SELECT state FROM public.commitments WHERE id = $1', [commitmentId])).rows[0].state

    report.equals('3.2', 'commitment is still pending after a stale sync', state, 'pending')
    report.equals('3.2b', 'qty_available is still 24', row.qty_available, 24)
    report.equals('3.2c', 'run report says commitments_still_pending = 1', sync1.report?.commitments_still_pending, 1)
    report.equals('3.2d', 'run report says commitments_confirmed = 0', sync1.report?.commitments_confirmed, 0)

    /* ---------------------------------------------------------------- *
     * 3.3 — five more identical syncs. No accumulation retires it.
     * ---------------------------------------------------------------- */
    for (let i = 0; i < 5; i += 1) {
      await applySyncAs(client, ADMIN_UID, { rows: [BASELINE], matches: [] })
    }
    row = await inventoryRow(client, 'SEA-9007')
    state = (await client.query('SELECT state FROM public.commitments WHERE id = $1', [commitmentId])).rows[0].state
    report.equals('3.3', 'still pending after six syncs in total', state, 'pending')
    report.equals('3.3b', 'qty_available still 24 after six syncs', row.qty_available, 24)

    /* ---------------------------------------------------------------- *
     * 3.4 — elapsed time changes nothing.
     *
     * The lifecycle trigger forbids editing created_at for EVERY caller,
     * including the table owner, so simulating elapsed time requires
     * disabling it. That refusal is itself asserted first: it is the
     * immutability guard doing its job.
     * ---------------------------------------------------------------- */
    const ageAttempt = await attempt(
      client,
      'postgres',
      null,
      `UPDATE public.commitments SET created_at = now() - interval '30 days' WHERE id = $1`,
      [commitmentId],
    ).catch(() => null)
    // attempt() sets SET LOCAL ROLE, which for 'postgres' is a no-op superuser role; the
    // trigger fires regardless of role.
    report.check(
      '3.4a',
      'even the table owner cannot rewrite created_at (KY006 immutability guard)',
      ageAttempt && ageAttempt.ok === false && ageAttempt.code === 'KY006',
      `observed ${ageAttempt?.code}: ${ageAttempt?.message}`,
    )

    await client.query('ALTER TABLE public.commitments DISABLE TRIGGER commitments_enforce_invariants')
    await client.query(
      `UPDATE public.commitments SET created_at = now() - interval '30 days' WHERE id = $1`,
      [commitmentId],
    )
    await client.query('ALTER TABLE public.commitments ENABLE TRIGGER commitments_enforce_invariants')

    row = await inventoryRow(client, 'SEA-9007')
    state = (await client.query('SELECT state FROM public.commitments WHERE id = $1', [commitmentId])).rows[0].state
    report.equals('3.4', 'a 30-day-old commitment is still pending', state, 'pending')
    report.equals('3.4b', 'qty_available still 24 after ageing', row.qty_available, 24)

    /* ---------------------------------------------------------------- *
     * 3.5 — sync again after ageing
     * ---------------------------------------------------------------- */
    const sync5 = await applySyncAs(client, ADMIN_UID, { rows: [BASELINE], matches: [] })
    row = await inventoryRow(client, 'SEA-9007')
    state = (await client.query('SELECT state FROM public.commitments WHERE id = $1', [commitmentId])).rows[0].state
    report.equals('3.5', 'still pending after a sync on a 30-day-old commitment', state, 'pending')
    report.equals('3.5b', 'qty_available still 24', row.qty_available, 24)
    report.equals('3.5c', 'run report still reports it pending', sync5.report?.commitments_still_pending, 1)

    /* ---------------------------------------------------------------- *
     * 3.6 — static assertion on the deployed function body, read back
     *       from the live database. Guards against a future "helpful"
     *       cleanup being added.
     * ---------------------------------------------------------------- */
    const def = (
      await client.query(
        `SELECT pg_get_functiondef(p.oid) AS src
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'apply_inventory_sync'`,
      )
    ).rows[0].src

    // The retirement block is section 2 of the function: from the "Retire deltas" marker to
    // the unmatched tally. Isolate it and assert no elapsed-time construct appears in it.
    const startIdx = def.indexOf('-- 2. Retire deltas')
    const endIdx = def.indexOf('SELECT count(*) INTO v_unmatched')
    const retirementBlock = startIdx >= 0 && endIdx > startIdx ? def.slice(startIdx, endIdx) : ''

    report.check(
      '3.6a',
      'the retirement block is locatable in the deployed function source',
      retirementBlock.length > 0,
      'could not isolate the retirement block from pg_get_functiondef output',
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
      report.check(
        `3.6 ${label}`,
        `retirement block contains no \`${label}\``,
        !re.test(retirementBlock),
        `found \`${label}\` in the retirement path`,
      )
    }

    // The structural backstop: pending -> retired must be unreachable in one step.
    const shortcut = await attempt(
      client,
      'postgres',
      null,
      `UPDATE public.commitments SET state = 'retired', confirmed_at = now(), retired_at = now() WHERE id = $1`,
      [commitmentId],
    )
    report.refused(
      '3.7',
      'pending -> retired refused even for a privileged caller (KY006)',
      shortcut,
      'KY006',
    )

    /* ---------------------------------------------------------------- *
     * 3.8 — a sync WITH a real match. The source has absorbed the delta.
     *
     * qty_available must NOT move: the baseline write and the state change
     * happen in the same transaction, so there is no upward blip and no
     * double count.
     * ---------------------------------------------------------------- */
    const sync8 = await applySyncAs(client, ADMIN_UID, {
      rows: [{ ...BASELINE, qty_committed: 16 }],
      matches: [
        { commitment_id: commitmentId, sku: 'SEA-9007', location: 'default', qty: 6, source_ref: 'SO-10241' },
      ],
    })
    row = await inventoryRow(client, 'SEA-9007')
    const confirmed = (
      await client.query('SELECT state, source_ref, confirmed_at FROM public.commitments WHERE id = $1', [commitmentId])
    ).rows[0]

    report.equals('3.8', 'commitment becomes confirmed_in_source', confirmed.state, 'confirmed_in_source')
    report.equals('3.8b', 'source_ref is recorded', confirmed.source_ref, 'SO-10241')
    report.check('3.8c', 'confirmed_at is set', confirmed.confirmed_at !== null, 'confirmed_at is NULL')
    report.equals('3.8d', 'qty_committed_portal is back to 0', row.qty_committed_portal, 0)
    report.equals('3.8e', 'qty_available is STILL 24 — no double count, no upward blip', row.qty_available, 24)
    report.equals('3.8f', 'run report says commitments_confirmed = 1', sync8.report?.commitments_confirmed, 1)

    /* ---------------------------------------------------------------- *
     * 3.9 — mismatch: the match names the right commitment but the wrong qty
     * ---------------------------------------------------------------- */
    const commit2 = await recordCommitmentAs(client, REP_UID, 'SEA-9007', 6, 'attack 3 mismatch case')
    const sync9 = await applySyncAs(client, ADMIN_UID, {
      rows: [{ ...BASELINE, qty_committed: 16 }],
      matches: [
        { commitment_id: commit2.row.id, sku: 'SEA-9007', location: 'default', qty: 5, source_ref: 'SO-10242' },
      ],
    })
    const state9 = (await client.query('SELECT state FROM public.commitments WHERE id = $1', [commit2.row.id])).rows[0].state
    const rejected9 = JSON.stringify(sync9.report?.rejected ?? [])

    report.equals('3.9', 'a qty disagreement does NOT confirm the commitment', state9, 'pending')
    report.check(
      '3.9b',
      'run report records match_fields_disagree',
      rejected9.includes('match_fields_disagree'),
      `rejected = ${rejected9}`,
    )

    /* ---------------------------------------------------------------- *
     * 3.10 — unknown commitment id
     * ---------------------------------------------------------------- */
    const before10 = (await client.query('SELECT id, state FROM public.commitments ORDER BY id')).rows
    const sync10 = await applySyncAs(client, ADMIN_UID, {
      rows: [],
      matches: [
        { commitment_id: '00000000-0000-4000-8000-0000000000ff', sku: 'SEA-9007', location: 'default', qty: 6 },
      ],
    })
    const after10 = (await client.query('SELECT id, state FROM public.commitments ORDER BY id')).rows
    report.check(
      '3.10',
      'an unknown commitment id is reported, not acted on',
      JSON.stringify(sync10.report?.rejected ?? []).includes('unknown_commitment'),
      `rejected = ${JSON.stringify(sync10.report?.rejected ?? [])}`,
    )
    report.check(
      '3.10b',
      'no commitment was altered',
      JSON.stringify(before10) === JSON.stringify(after10),
      'commitment states changed during an unknown-match sync',
    )

    /* ---------------------------------------------------------------- *
     * 3.11 — override preservation. Show both numbers, never silently
     *        override.
     * ---------------------------------------------------------------- */
    const ovBefore = await inventoryRow(client, 'SEA-9003')
    const sync11 = await applySyncAs(client, ADMIN_UID, {
      rows: [
        { sku: 'SEA-9003', location: 'default', qty_on_hand: 60, qty_committed: 6, qty_incoming: 0, incoming_eta: null, source: 'quickbooks_stub' },
      ],
      matches: [],
    })
    const ovAfter = await inventoryRow(client, 'SEA-9003')
    const payload = (
      await client.query(`SELECT source_payload FROM public.inventory WHERE sku = 'SEA-9003' AND location = 'default'`)
    ).rows[0].source_payload

    report.equals('3.11', 'override quantities are unchanged by the sync', `${ovAfter.qty_on_hand}/${ovAfter.qty_committed_source}`, `${ovBefore.qty_on_hand}/${ovBefore.qty_committed_source}`)
    report.equals('3.11b', 'the row is still a manual_override', ovAfter.source, 'manual_override')
    report.check(
      '3.11c',
      'source_payload.last_source_snapshot records what the source claimed',
      payload?.last_source_snapshot?.qty_on_hand === 60,
      `last_source_snapshot = ${JSON.stringify(payload?.last_source_snapshot)}`,
    )
    report.equals('3.11d', 'run report says overrides_preserved = 1', sync11.report?.overrides_preserved, 1)
    report.equals('3.11e', 'run report says rows_applied = 0', sync11.report?.rows_applied, 0)

    return report
  } finally {
    await client.end()
  }
}
