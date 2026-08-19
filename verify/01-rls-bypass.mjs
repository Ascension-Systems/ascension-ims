/**
 * ATTACK 1 — RLS bypass.
 *
 * Method: connect as `rep` (identity 1) and query DIRECTLY OVER SQL, not through the UI.
 * An admin-session control run confirms the rows actually exist, so a refusal is
 * distinguished from an empty table.
 *
 * A pass requires demonstrating the REFUSAL, not the absence of a UI button.
 *
 * ------------------------------------------------------------------------------------
 * A NOTE ON RLS-FILTERED UPDATE/DELETE, WHICH THE PLAN PREDICTS AS 42501
 * ------------------------------------------------------------------------------------
 * Postgres does not raise on an UPDATE or DELETE that an RLS USING clause filters out. The
 * rows are simply invisible to the statement, so it reports 0 rows affected and no error.
 * 42501 is raised for INSERT (a WITH CHECK violation) and for any command the role lacks
 * the table GRANT for -- which is why every write to `commitments` does raise.
 *
 * "No error and 0 rows" is NOT accepted here on its own. For each filtered write this
 * harness asserts three things together, which is strictly stronger evidence than a bare
 * SQLSTATE check:
 *
 *   (a) the statement affected 0 rows,
 *   (b) the target row is byte-identical afterwards, re-read independently, and
 *   (c) the IDENTICAL statement, run as `admin`, affects >= 1 row.
 *
 * (c) is what makes it a demonstration of the policy rather than of a broken statement or a
 * blanket denial.
 */

import {
  Report,
  ownerClient,
  bootstrap,
  recordCommitmentAs,
  applySyncAs,
  repAttempt,
  adminAttempt,
  anonAttempt,
  REP_UID,
  ADMIN_UID,
} from './lib/harness.mjs'

const METHOD = `signed in as a rep, every read and write is issued directly over SQL with
RLS live (SET LOCAL ROLE authenticated + the request.jwt.claims the
policies read). An admin control run proves the forbidden rows exist.
Filtered writes are asserted three ways: 0 rows affected, target row
unchanged on re-read, and the same statement succeeding as admin.`

export default async function attack1(db) {
  const report = new Report(1, 'RLS bypass', METHOD)
  const client = await ownerClient(db)

  try {
    await bootstrap(db, client)

    /* ---------------------------------------------------------------- *
     * Setup: one commitment owned by the rep, one owned by the admin,
     * both created through record_commitment() under their own identity.
     * SEA-9002 has availability 14, so both fit.
     * ---------------------------------------------------------------- */
    const repCommit = await recordCommitmentAs(client, REP_UID, 'SEA-9002', 3, 'rep commitment')
    const adminCommit = await recordCommitmentAs(client, ADMIN_UID, 'SEA-9002', 2, 'admin commitment')

    if (!repCommit.ok || !adminCommit.ok) {
      report.fail('1.0', 'setup: two commitments recorded', `${repCommit.message ?? ''} ${adminCommit.message ?? ''}`)
      return report
    }
    const adminCommitmentId = adminCommit.row.id

    // A sync run, so 1.3 has a real row to be refused rather than an empty table.
    await applySyncAs(client, ADMIN_UID, { rows: [], matches: [] })

    /* ---------------------------------------------------------------- *
     * 1.1 — read every commitment
     * ---------------------------------------------------------------- */
    const allCommitments = await repAttempt(client, 'SELECT id, rep_id FROM public.commitments')
    const controlCommitments = await adminAttempt(client, 'SELECT id, rep_id FROM public.commitments')

    report.check(
      '1.1',
      'rep SELECT commitments returns only own rows',
      allCommitments.ok &&
        allCommitments.rows.length === 1 &&
        allCommitments.rows.every((r) => r.rep_id === REP_UID),
      `rep saw ${allCommitments.rows.length} row(s) ${JSON.stringify(allCommitments.rows.map((r) => r.rep_id))}; admin control sees ${controlCommitments.rows.length}`,
    )
    report.check(
      '1.1b',
      "admin control proves the other rep's row exists",
      controlCommitments.ok && controlCommitments.rows.length === 2,
      `admin saw ${controlCommitments.rows.length} rows, expected 2`,
    )

    /* ---------------------------------------------------------------- *
     * 1.2 — name the forbidden row directly
     * ---------------------------------------------------------------- */
    const named = await repAttempt(client, 'SELECT * FROM public.commitments WHERE id = $1', [
      adminCommitmentId,
    ])
    report.check(
      '1.2',
      "naming another user's commitment by id returns 0 rows",
      named.ok && named.rows.length === 0,
      `returned ${named.rows.length} rows`,
    )

    /* ---------------------------------------------------------------- *
     * 1.3 — a forbidden table that is not commitments
     * ---------------------------------------------------------------- */
    const repRuns = await repAttempt(client, 'SELECT * FROM public.inventory_sync_runs')
    const adminRuns = await adminAttempt(client, 'SELECT * FROM public.inventory_sync_runs')
    report.check(
      '1.3',
      'rep SELECT inventory_sync_runs returns 0 rows',
      repRuns.ok && repRuns.rows.length === 0,
      `returned ${repRuns.rows.length} rows`,
    )
    report.check(
      '1.3b',
      'admin control returns >= 1 sync run',
      adminRuns.ok && adminRuns.rows.length >= 1,
      `admin saw ${adminRuns.rows.length} rows`,
    )

    /* ---------------------------------------------------------------- *
     * 1.4 — profiles
     * ---------------------------------------------------------------- */
    const repProfiles = await repAttempt(client, 'SELECT id, role FROM public.profiles')
    report.check(
      '1.4',
      'rep SELECT profiles returns exactly 1 row (own)',
      repProfiles.ok && repProfiles.rows.length === 1 && repProfiles.rows[0].id === REP_UID,
      `returned ${repProfiles.rows.length} rows: ${JSON.stringify(repProfiles.rows)}`,
    )

    /* ---------------------------------------------------------------- *
     * 1.5 — write to inventory
     * ---------------------------------------------------------------- */
    const before = await client.query(
      `SELECT qty_on_hand FROM public.inventory WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    const repUpdate = await repAttempt(
      client,
      `UPDATE public.inventory SET qty_on_hand = 9999 WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    const after = await client.query(
      `SELECT qty_on_hand FROM public.inventory WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    const adminUpdate = await adminAttempt(
      client,
      `UPDATE public.inventory SET qty_on_hand = 9999 WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    report.check(
      '1.5',
      'rep UPDATE inventory affects 0 rows and leaves it unchanged',
      repUpdate.rowCount === 0 &&
        after.rows[0].qty_on_hand === before.rows[0].qty_on_hand &&
        after.rows[0].qty_on_hand === 1,
      `rowCount=${repUpdate.rowCount} code=${repUpdate.code} qty_on_hand ${before.rows[0].qty_on_hand} -> ${after.rows[0].qty_on_hand}`,
    )
    report.check(
      '1.5b',
      'admin control: the identical UPDATE affects 1 row',
      adminUpdate.ok && adminUpdate.rowCount === 1,
      `rowCount=${adminUpdate.rowCount} code=${adminUpdate.code} ${adminUpdate.message ?? ''}`,
    )

    /* ---------------------------------------------------------------- *
     * 1.6 — INSERT into inventory (WITH CHECK violation -> a real 42501)
     * ---------------------------------------------------------------- */
    const repInsertInv = await repAttempt(
      client,
      `INSERT INTO public.inventory (sku, location, qty_on_hand) VALUES ('SEA-9006', 'depot-2', 25)`,
    )
    report.refused('1.6', 'rep INSERT INTO inventory refused', repInsertInv, '42501')

    /* ---------------------------------------------------------------- *
     * 1.7 — DELETE from inventory
     * ---------------------------------------------------------------- */
    const repDelete = await repAttempt(
      client,
      `DELETE FROM public.inventory WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    const survived = await client.query(
      `SELECT count(*)::int AS n FROM public.inventory WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    const adminDelete = await adminAttempt(
      client,
      `DELETE FROM public.inventory WHERE sku = 'SEA-9006' AND location = 'default'`,
    )
    report.check(
      '1.7',
      'rep DELETE FROM inventory affects 0 rows; the row survives',
      repDelete.rowCount === 0 && survived.rows[0].n === 1,
      `rowCount=${repDelete.rowCount}, rows remaining=${survived.rows[0].n}`,
    )
    report.check(
      '1.7b',
      'admin control: the identical DELETE affects 1 row',
      adminDelete.ok && adminDelete.rowCount === 1,
      `rowCount=${adminDelete.rowCount} code=${adminDelete.code}`,
    )

    /* ---------------------------------------------------------------- *
     * 1.8 — the one that would defeat attack 2 if it succeeded
     * ---------------------------------------------------------------- */
    const directInsert = await repAttempt(
      client,
      `INSERT INTO public.commitments (sku, location, qty, rep_id, state)
       VALUES ('SEA-9006', 'default', 1, $1, 'pending')`,
      [REP_UID],
    )
    report.refused(
      '1.8',
      'rep INSERT INTO commitments directly, bypassing the RPC, refused',
      directInsert,
      '42501',
    )
    const adminDirectInsert = await adminAttempt(
      client,
      `INSERT INTO public.commitments (sku, location, qty, rep_id, state)
       VALUES ('SEA-9006', 'default', 1, $1, 'pending')`,
      [ADMIN_UID],
    )
    report.refused(
      '1.8b',
      'admin is refused the same direct INSERT (not a privilege admin has either)',
      adminDirectInsert,
      '42501',
    )

    /* ---------------------------------------------------------------- *
     * 1.9 — no UPDATE policy exists on commitments, for anyone
     * ---------------------------------------------------------------- */
    const directUpdate = await repAttempt(
      client,
      `UPDATE public.commitments SET state = 'retired' WHERE rep_id = auth.uid()`,
    )
    report.refused('1.9', 'rep UPDATE commitments refused', directUpdate, '42501')

    /* ---------------------------------------------------------------- *
     * 1.10 / 1.11 — anon, holding nothing but the anon key
     * ---------------------------------------------------------------- */
    const anonView = await anonAttempt(client, 'SELECT * FROM public.v_inventory')
    report.refused('1.10', 'anon SELECT v_inventory refused', anonView, '42501')

    const anonCommitments = await anonAttempt(client, 'SELECT * FROM public.commitments')
    report.refused('1.11', 'anon SELECT commitments refused', anonCommitments, '42501')

    /* ---------------------------------------------------------------- *
     * 1.12 — the view-owner bypass. Asserts the mitigation is actually
     *        present rather than assumed.
     * ---------------------------------------------------------------- */
    const opts = await client.query(
      `SELECT reloptions FROM pg_class WHERE relname = 'v_inventory' AND relnamespace = 'public'::regnamespace`,
    )
    const reloptions = opts.rows[0]?.reloptions ?? []
    report.check(
      '1.12',
      'v_inventory carries security_invoker (a default view is a full RLS bypass)',
      reloptions.some((o) => /^security_invoker=(on|true)$/i.test(o)),
      `reloptions = ${JSON.stringify(reloptions)}`,
    )

    return report
  } finally {
    await client.end()
  }
}
