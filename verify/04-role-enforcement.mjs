/**
 * ATTACK 4 — role enforcement is server-side.
 *
 * Each admin-only action is invoked DIRECTLY as a `rep`, at the layer where the check is
 * claimed to live. Hiding a button is not access control and is not tested here. 4.1 through
 * 4.8 bypass the route handlers entirely, on purpose.
 *
 * 4.12 is NOT OPTIONAL. Without it, a build that refused everything for everyone would pass
 * 4.1 through 4.11 and be reported as secure.
 *
 * On the two forms a refusal takes — see the long note at the top of 01-rls-bypass.mjs.
 * INSERTs and any command the role lacks a GRANT for raise 42501. An UPDATE or DELETE the
 * RLS USING clause filters out reports 0 rows and no error, so it is asserted as: 0 rows
 * affected + target unchanged + the identical statement succeeding as admin.
 */

import {
  Report,
  ownerClient,
  bootstrap,
  repAttempt,
  adminAttempt,
  anonAttempt,
  applySyncAs,
  ADMIN_UID,
} from './lib/harness.mjs'

const METHOD = `every admin-only action is issued directly over SQL in a rep session, at the
layer the plan claims enforces it — not through the route handlers. Refusals
are asserted by SQLSTATE where Postgres raises one, and by (0 rows affected +
target unchanged + identical statement succeeding as admin) where RLS filters
silently. A control block re-runs three of them as admin to prove the tests
discriminate by role rather than denying everything.`

export default async function attack4(db) {
  const report = new Report(4, 'Role enforcement is server-side', METHOD)
  const client = await ownerClient(db)

  try {
    await bootstrap(db, client)

    /* ---------------------------------------------------------------- *
     * 4.1 — edit inventory quantities. RLS inventory_update_admin.
     * ---------------------------------------------------------------- */
    const invBefore = (
      await client.query(`SELECT qty_on_hand FROM public.inventory WHERE sku = 'SEA-9007' AND location = 'default'`)
    ).rows[0].qty_on_hand
    const r41 = await repAttempt(
      client,
      `UPDATE public.inventory SET qty_on_hand = 4000 WHERE sku = 'SEA-9007' AND location = 'default'`,
    )
    const invAfter = (
      await client.query(`SELECT qty_on_hand FROM public.inventory WHERE sku = 'SEA-9007' AND location = 'default'`)
    ).rows[0].qty_on_hand
    report.check(
      '4.1',
      'rep UPDATE inventory: 0 rows, quantity unchanged',
      r41.rowCount === 0 && invAfter === invBefore && invAfter === 40,
      `rowCount=${r41.rowCount} code=${r41.code} qty ${invBefore} -> ${invAfter}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.2 — create a product. RLS products_insert_admin (WITH CHECK).
     * ---------------------------------------------------------------- */
    const r42 = await repAttempt(
      client,
      `INSERT INTO public.products (sku, name, category) VALUES ('ZZZ-0001', 'Injected Product', 'Seating')`,
    )
    report.refused('4.2', 'rep INSERT INTO products refused', r42, '42501')

    /* ---------------------------------------------------------------- *
     * 4.3 — delete a product. RLS products_delete_admin.
     * ---------------------------------------------------------------- */
    const r43 = await repAttempt(client, `DELETE FROM public.products WHERE sku = 'SEA-9007'`)
    const survives = (
      await client.query(`SELECT count(*)::int AS n FROM public.products WHERE sku = 'SEA-9007'`)
    ).rows[0].n
    report.check(
      '4.3',
      'rep DELETE FROM products: 0 rows, product survives',
      r43.rowCount === 0 && survives === 1,
      `rowCount=${r43.rowCount} code=${r43.code} remaining=${survives}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.4 — change the authority flag. RLS app_settings_update_admin.
     * ---------------------------------------------------------------- */
    const r44 = await repAttempt(
      client,
      `UPDATE public.app_settings SET inventory_authority = 'portal' WHERE id`,
    )
    const authority = (await client.query('SELECT inventory_authority FROM public.app_settings')).rows[0]
      .inventory_authority
    report.check(
      '4.4',
      "rep UPDATE app_settings: 0 rows, authority still 'quickbooks'",
      r44.rowCount === 0 && authority === 'quickbooks',
      `rowCount=${r44.rowCount} code=${r44.code} authority=${authority}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.5 — read sync history. RLS sync_runs_select_admin.
     * ---------------------------------------------------------------- */
    await applySyncAs(client, ADMIN_UID, { rows: [], matches: [] })

    const r45 = await repAttempt(client, 'SELECT * FROM public.inventory_sync_runs')
    const r45control = await adminAttempt(client, 'SELECT * FROM public.inventory_sync_runs')
    report.check(
      '4.5',
      'rep SELECT inventory_sync_runs returns 0 rows',
      r45.ok && r45.rows.length === 0,
      `returned ${r45.rows.length} rows`,
    )
    report.check(
      '4.5b',
      'admin control returns >= 1, so 4.5 is a refusal and not an empty table',
      r45control.ok && r45control.rows.length >= 1,
      `admin returned ${r45control.rows.length} rows`,
    )

    /* ---------------------------------------------------------------- *
     * 4.6 — run a sync. Guard INSIDE the SECURITY DEFINER function.
     * ---------------------------------------------------------------- */
    const r46 = await repAttempt(client, `SELECT public.apply_inventory_sync('{"rows":[]}'::jsonb)`)
    report.refused('4.6', 'rep apply_inventory_sync refused with KY003', r46, 'KY003')
    report.check(
      '4.6b',
      "the refusal message reads 'admin role required'",
      /admin role required/i.test(r46.message ?? ''),
      `observed: ${r46.message}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.7 — self-promotion. RLS profiles_update_admin.
     * ---------------------------------------------------------------- */
    const r47 = await repAttempt(
      client,
      `UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid()`,
    )
    const repRole = (
      await client.query(`SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-000000000001'`)
    ).rows[0].role
    report.check(
      '4.7',
      "rep self-promotion to admin: 0 rows, role still 'rep'",
      r47.rowCount === 0 && repRole === 'rep',
      `rowCount=${r47.rowCount} code=${r47.code} role=${repRole}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.8 — write a commitment row directly. No policy exists, for anyone.
     * ---------------------------------------------------------------- */
    const r48 = await repAttempt(
      client,
      `INSERT INTO public.commitments (sku, location, qty, rep_id, state)
       VALUES ('SEA-9007', 'default', 5, auth.uid(), 'pending')`,
    )
    report.refused('4.8', 'rep INSERT INTO commitments refused', r48, '42501')

    /* ---------------------------------------------------------------- *
     * 4.9 / 4.10 — the HTTP surface
     * ---------------------------------------------------------------- */
    if (process.env.PORTAL_BASE_URL) {
      const withSession = await fetch(`${process.env.PORTAL_BASE_URL}/api/sync`, {
        method: 'POST',
        headers: process.env.PORTAL_REP_COOKIE ? { cookie: process.env.PORTAL_REP_COOKIE } : {},
      })
      const body9 = await withSession.json().catch(() => ({}))
      report.check(
        '4.9',
        'POST /api/sync with a rep session returns 403 FORBIDDEN_ROLE',
        withSession.status === 403 && body9.error === 'FORBIDDEN_ROLE',
        `observed HTTP ${withSession.status} ${JSON.stringify(body9)}`,
      )

      const noSession = await fetch(`${process.env.PORTAL_BASE_URL}/api/sync`, { method: 'POST' })
      const body10 = await noSession.json().catch(() => ({}))
      report.check(
        '4.10',
        'POST /api/sync with no session returns 401',
        noSession.status === 401,
        `observed HTTP ${noSession.status} ${JSON.stringify(body10)}`,
      )
    } else {
      const reason =
        'requires a running app server AND a live Supabase endpoint for it to talk to. ' +
        'Set PORTAL_BASE_URL (and PORTAL_REP_COOKIE) to run these. NOT RUN in this environment. ' +
        'The database-level refusal underneath both (4.6) IS executed for real, and the plan ' +
        'states the database layer is the authoritative one — the route guards exist to return ' +
        'a clean 403/401 instead of a 500.'
      report.skip('4.9', 'POST /api/sync with a rep session returns 403 FORBIDDEN_ROLE', reason)
      report.skip('4.10', 'POST /api/sync with no session returns 401', reason)
    }

    /* ---------------------------------------------------------------- *
     * 4.11 — as anon. EXECUTE is revoked, so the guard's NULL-uid branch
     *        is never even reached.
     * ---------------------------------------------------------------- */
    const r411 = await anonAttempt(client, `SELECT public.apply_inventory_sync('{"rows":[]}'::jsonb)`)
    report.refused('4.11', 'anon apply_inventory_sync refused by the EXECUTE revoke', r411, '42501')
    report.check(
      '4.11b',
      'the refusal is a permission denial, not the KY003 role guard',
      /permission denied/i.test(r411.message ?? ''),
      `observed: ${r411.message}`,
    )

    /* ---------------------------------------------------------------- *
     * 4.12 — CONTROL. The same actions as admin must SUCCEED.
     * ---------------------------------------------------------------- */
    const c1 = await adminAttempt(
      client,
      `UPDATE public.inventory SET qty_on_hand = 4000 WHERE sku = 'SEA-9007' AND location = 'default'`,
    )
    report.check(
      '4.12a',
      'admin UPDATE inventory succeeds (1 row)',
      c1.ok && c1.rowCount === 1,
      `rowCount=${c1.rowCount} code=${c1.code} ${c1.message ?? ''}`,
    )

    const c2 = await adminAttempt(
      client,
      `UPDATE public.app_settings SET inventory_authority = 'portal' WHERE id`,
    )
    report.check(
      '4.12b',
      'admin UPDATE app_settings succeeds (1 row)',
      c2.ok && c2.rowCount === 1,
      `rowCount=${c2.rowCount} code=${c2.code} ${c2.message ?? ''}`,
    )

    const c3 = await adminAttempt(client, `SELECT public.apply_inventory_sync('{"rows":[]}'::jsonb)`)
    report.check(
      '4.12c',
      'admin apply_inventory_sync succeeds',
      c3.ok,
      `code=${c3.code} ${c3.message ?? ''}`,
    )

    return report
  } finally {
    await client.end()
  }
}
