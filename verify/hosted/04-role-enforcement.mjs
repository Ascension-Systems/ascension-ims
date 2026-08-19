/**
 * ATTACK 4 — role enforcement is server-side, against the hosted project.
 *
 * Each admin-only action is invoked DIRECTLY as a rep, at the layer where the check is
 * claimed to live. Hiding a button is not access control and is not tested here. 4.1 through
 * 4.8 bypass the route handlers entirely, on purpose.
 *
 * 4.12 IS NOT OPTIONAL. Without it, a build that refused everything for everyone would pass
 * 4.1 through 4.11 and be reported as secure.
 *
 * ------------------------------------------------------------------------------------
 * 4.12b — THE ONE GENUINELY DANGEROUS CONTROL, AND WHY IT IS WRITTEN THE WAY IT IS
 * ------------------------------------------------------------------------------------
 * `app_settings` is a singleton and there is no disposable copy of it. The local harness
 * sets `inventory_authority = 'portal'` and relies on ROLLBACK. Over PostgREST there is no
 * rollback: that write would commit and flip the live portal's authority mode for every user
 * until something set it back.
 *
 * So this file READS the current value and PATCHes THAT SAME VALUE, asserting 1 row
 * affected. The affected-row count is 1 whether or not the value changed, so the policy is
 * proven exactly as strongly, with no state change, no restore window, and nothing left
 * wrong if the harness is killed mid-run.
 *
 * The evidential point of "identical statement" is to rule out a broken WHERE clause, and
 * the WHERE clause IS identical to the rep's attempt in 4.4 (`id=eq.true`). Only the SET
 * value differs, and it differs in the safe direction.
 */

import { Report } from '../lib/report.mjs'
import {
  selectRows,
  insertRows,
  updateRows,
  deleteRows,
  countRows,
  rpc,
  appFetch,
  appFetchNoSession,
  isLoginRedirect,
} from './lib/client.mjs'
import {
  KYV_LOCATION,
  SKU,
  SKU_FORBIDDEN_INSERT,
  resetFixtures,
  rawInventoryRow,
  applySync,
} from './lib/fixtures.mjs'

const METHOD = `every admin-only action is issued directly at PostgREST in a real rep session,
at the layer the plan claims enforces it — not through the route handlers.
Refusals are asserted by SQLSTATE where Postgres raises one, and by (0 rows
affected + target unchanged + the identical request succeeding as admin) where
RLS filters silently. A control block re-runs three of them as admin. Writes are
confined to the KYV namespace; app_settings is written back to its own value.`

const q = encodeURIComponent

export default async function attack4(ctx) {
  const { cfg, identities, uids, app } = ctx
  const report = new Report(4, 'Role enforcement is server-side', METHOD)

  await resetFixtures(cfg, identities)

  /* ---------------------------------------------------------------- *
   * 4.1 — edit inventory quantities. RLS inventory_update_admin.
   * ---------------------------------------------------------------- */
  const invFilter = `sku=eq.${q(SKU.INV)}&location=eq.${q(KYV_LOCATION)}`
  const invBefore = (await rawInventoryRow(cfg, identities, SKU.INV))?.qty_on_hand
  const r41 = await updateRows(cfg, identities.rep, 'inventory', invFilter, { qty_on_hand: 4000 })
  const invAfter = (await rawInventoryRow(cfg, identities, SKU.INV))?.qty_on_hand
  report.check(
    '4.1',
    'rep UPDATE inventory: 0 rows, quantity unchanged',
    r41.ok && r41.rowCount === 0 && invAfter === invBefore && invAfter === 100,
    `rowCount=${r41.rowCount} code=${r41.code} qty ${invBefore} -> ${invAfter}`,
  )

  /* ---------------------------------------------------------------- *
   * 4.2 — create a product. RLS products_insert_admin (WITH CHECK).
   *       The sku is inside the KYV- namespace so that a failure of this
   *       assertion leaves an artefact the teardown still sweeps up.
   * ---------------------------------------------------------------- */
  const r42 = await insertRows(cfg, identities.rep, 'products', [
    { sku: SKU_FORBIDDEN_INSERT, name: 'Injected Product', category: 'KYV verification artefact' },
  ])
  report.refused('4.2', 'rep INSERT INTO products refused', r42, '42501')

  /* ---------------------------------------------------------------- *
   * 4.3 — delete a product. RLS products_delete_admin.
   * ---------------------------------------------------------------- */
  const r43 = await deleteRows(cfg, identities.rep, 'products', `sku=eq.${q(SKU.DEL)}`)
  const survives = await selectRows(
    cfg,
    identities.service,
    'products',
    `select=sku&sku=eq.${q(SKU.DEL)}`,
  )
  report.check(
    '4.3',
    'rep DELETE FROM products: 0 rows, product survives',
    r43.ok && r43.rowCount === 0 && survives.ok && survives.rowCount === 1,
    `rowCount=${r43.rowCount} code=${r43.code} remaining=${survives.rowCount}`,
  )

  /* ---------------------------------------------------------------- *
   * 4.4 — change the authority flag. RLS app_settings_update_admin.
   *       Refused, therefore non-mutating.
   * ---------------------------------------------------------------- */
  const authBefore = await selectRows(
    cfg,
    identities.service,
    'app_settings',
    'select=inventory_authority&id=eq.true',
  )
  const currentAuthority = authBefore.ok ? authBefore.rows[0]?.inventory_authority : null
  const r44 = await updateRows(cfg, identities.rep, 'app_settings', 'id=eq.true', {
    inventory_authority: 'portal',
  })
  const authAfterRead = await selectRows(
    cfg,
    identities.service,
    'app_settings',
    'select=inventory_authority&id=eq.true',
  )
  const authAfter = authAfterRead.ok ? authAfterRead.rows[0]?.inventory_authority : null
  report.check(
    '4.4',
    'rep UPDATE app_settings: 0 rows, authority unchanged',
    r44.ok && r44.rowCount === 0 && currentAuthority !== null && authAfter === currentAuthority,
    `rowCount=${r44.rowCount} code=${r44.code} authority ${currentAuthority} -> ${authAfter}`,
  )

  /* ---------------------------------------------------------------- *
   * 4.5 — read sync history. RLS sync_runs_select_admin.
   * ---------------------------------------------------------------- */
  await applySync(cfg, identities.admin, { rows: [], matches: [] })

  const r45 = await selectRows(cfg, identities.rep, 'inventory_sync_runs', 'select=id')
  const r45control = await selectRows(cfg, identities.admin, 'inventory_sync_runs', 'select=id')
  report.check(
    '4.5',
    'rep SELECT inventory_sync_runs returns 0 rows',
    r45.ok && r45.rowCount === 0,
    `returned ${r45.rowCount} rows (code ${r45.code ?? 'ok'})`,
  )
  report.check(
    '4.5b',
    'admin control returns >= 1, so 4.5 is a refusal and not an empty table',
    r45control.ok && r45control.rowCount >= 1,
    `admin returned ${r45control.rowCount} rows (code ${r45control.code ?? 'ok'})`,
  )

  /* ---------------------------------------------------------------- *
   * 4.6 — run a sync. Guard INSIDE the SECURITY DEFINER function.
   * ---------------------------------------------------------------- */
  const r46 = await rpc(cfg, identities.rep, 'apply_inventory_sync', { p_payload: { rows: [] } })
  report.refused('4.6', 'rep apply_inventory_sync refused with KY003', r46, 'KY003')
  report.check(
    '4.6b',
    "the refusal message reads 'admin role required'",
    /admin role required/i.test(r46.message ?? ''),
    `observed: ${r46.message}`,
  )

  /* ---------------------------------------------------------------- *
   * 4.7 — self-promotion. RLS profiles_update_admin. The UPDATE grant
   *       exists (0012:30) so the policy is genuinely reached.
   * ---------------------------------------------------------------- */
  const r47 = await updateRows(cfg, identities.rep, 'profiles', `id=eq.${q(uids.rep)}`, {
    role: 'admin',
  })
  const roleAfter = await selectRows(
    cfg,
    identities.service,
    'profiles',
    `select=role&id=eq.${q(uids.rep)}`,
  )
  report.check(
    '4.7',
    "rep self-promotion to admin: 0 rows, role still 'rep'",
    r47.ok && r47.rowCount === 0 && roleAfter.rows[0]?.role === 'rep',
    `rowCount=${r47.rowCount} code=${r47.code} role=${roleAfter.rows[0]?.role}`,
  )

  /* ---------------------------------------------------------------- *
   * 4.8 — write a commitment row directly. No policy exists, for anyone.
   * ---------------------------------------------------------------- */
  const r48 = await insertRows(cfg, identities.rep, 'commitments', [
    { sku: SKU.DLT, location: KYV_LOCATION, qty: 5, rep_id: uids.rep, state: 'pending' },
  ])
  report.refused('4.8', 'rep INSERT INTO commitments refused', r48, '42501')

  /* ---------------------------------------------------------------- *
   * 4.9 / 4.10 / 4.10b — the HTTP surface.
   *
   * middleware.ts matches /api/* and runs BEFORE the route handler:
   *   - with a session it passes the request through, so 4.9 reaches
   *     requireAdmin() and the route's own 403 is what answers;
   *   - with NO session it redirects to /login, so the route's 401 is
   *     never reached. That redirect IS the refusal.
   *
   * 4.10 USED TO ACCEPT EITHER FORM — `noSession.status === 401 ||
   * redirected` — and that was itself a defect. A disjunction over two
   * different mechanisms cannot fail on the wrong mechanism: it proved
   * only that the request did not succeed, while wearing the label of a
   * much stronger claim. Same shape as the deleted SKIP status.
   *
   * So: 4.10 now asserts the ONE mechanism that actually answers — the
   * 307, specifically, to a Location whose path is /login — plus the
   * corroboration that matters (no inventory_sync_runs row appeared).
   * NextResponse.redirect(url) with no init defaults to 307, and
   * lib/supabase/middleware.ts:58 uses exactly that form.
   *
   * The route handler's own 401 is recorded as 4.10b, NOT EXECUTED,
   * because it is unreachable. Middleware refusing first is a STRONGER
   * refusal, not a weaker one, so middleware.ts is deliberately NOT
   * changed to make 4.10b reachable. The id is emitted on BOTH branches
   * below — an id that appears only sometimes makes the disposition
   * drift, which is the whole thing verify/lib/manifest.mjs exists to
   * prevent.
   * ---------------------------------------------------------------- */
  const ROUTE_401_UNREACHABLE =
    'NOT EXECUTED — unreachable: middleware.ts matches /api/* and redirects before the route ' +
    'handler runs. Middleware refusing first is a STRONGER refusal, not a weaker one, so ' +
    'middleware.ts is deliberately not changed to make this reachable.'
  const ROUTE_401_DESCRIPTION =
    "POST /api/sync with no session reaches the route handler's own 401"

  if (!app.usable) {
    const reason = `${app.reason}${app.detail ? ` — ${app.detail}` : ''}`
    report.notExecuted('4.9', 'POST /api/sync with a rep session returns 403 FORBIDDEN_ROLE', reason)
    report.notExecuted(
      '4.10',
      'POST /api/sync with no session is refused by middleware with a 307 to /login',
      reason,
    )
    // Unreachable for a DIFFERENT reason here, but the id must always appear.
    report.notExecuted('4.10b', ROUTE_401_DESCRIPTION, ROUTE_401_UNREACHABLE)
    report.notes.push(
      `4.10b: the route handler's own 401 in app/api/sync/route.ts is recorded as NOT ` +
        `EXECUTED on every run. ${ROUTE_401_UNREACHABLE}`,
    )
  } else {
    const withSession = await appFetch(cfg.portalBaseUrl, '/api/sync', {
      method: 'POST',
      cookie: app.cookie,
    })
    report.check(
      '4.9',
      'POST /api/sync with a rep session returns 403 FORBIDDEN_ROLE',
      withSession.status === 403 && withSession.body?.error === 'FORBIDDEN_ROLE',
      `observed HTTP ${withSession.status}${isLoginRedirect(withSession) ? ` -> ${withSession.location}` : ''} ${JSON.stringify(withSession.body)}`,
    )

    // Counted with Prefer: count=exact, not by measuring a returned array — a payload is
    // subject to whatever max-rows the deployment configures.
    const runsBefore = await countRows(cfg, identities.service, 'inventory_sync_runs')
    const noSession = await appFetchNoSession(cfg.portalBaseUrl, '/api/sync', { method: 'POST' })
    const runsAfter = await countRows(cfg, identities.service, 'inventory_sync_runs')

    // Asserted specifically. No disjunction: the 307, to /login, and no sync run.
    let redirectPath = null
    if (noSession.location) {
      try {
        redirectPath = new URL(noSession.location, cfg.portalBaseUrl).pathname
      } catch {
        redirectPath = null
      }
    }
    const noRunWritten = runsBefore.ok && runsAfter.ok && runsAfter.count === runsBefore.count

    report.check(
      '4.10',
      'POST /api/sync with no session is refused by middleware with a 307 to /login',
      noSession.status === 307 && redirectPath === '/login' && noRunWritten,
      `expected HTTP 307 -> path /login with no new sync run; observed HTTP ` +
        `${noSession.status}${noSession.location ? ` -> ${noSession.location}` : ''} ` +
        `(path ${redirectPath ?? 'none'}); inventory_sync_runs ${runsBefore.count} -> ${runsAfter.count}`,
    )
    report.notExecuted('4.10b', ROUTE_401_DESCRIPTION, ROUTE_401_UNREACHABLE)

    // Unconditional. The mechanism is not a discovery to be reported conditionally: the
    // refusal IS middleware's 307 and the route's 401 IS unreachable, on every run.
    report.notes.push(
      `4.10: the refusal is middleware.ts's 307 redirect to /login — the request never reaches ` +
        `app/api/sync/route.ts. Asserted specifically (307 AND Location path /login AND no new ` +
        `inventory_sync_runs row), not as "401 or a redirect". The route handler's own 401 is ` +
        `recorded separately as 4.10b, NOT EXECUTED: ${ROUTE_401_UNREACHABLE}`,
    )
  }

  /* ---------------------------------------------------------------- *
   * 4.11 — as anon. EXECUTE is revoked (0012:35), so the guard's
   *        NULL-uid branch is never even reached.
   * ---------------------------------------------------------------- */
  const r411 = await rpc(cfg, identities.anon, 'apply_inventory_sync', { p_payload: { rows: [] } })
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
  const c1 = await updateRows(cfg, identities.admin, 'inventory', invFilter, { qty_on_hand: 4000 })
  report.check(
    '4.12a',
    'admin UPDATE inventory succeeds (1 row)',
    c1.ok && c1.rowCount === 1,
    `rowCount=${c1.rowCount} code=${c1.code} ${c1.message ?? ''}`,
  )

  if (currentAuthority === null) {
    report.notExecuted(
      '4.12b',
      'admin UPDATE app_settings succeeds (1 row)',
      'NOT EXECUTED — the current inventory_authority could not be read, so there is no safe ' +
        'value to write back. This control is never run with a value other than the one ' +
        'already stored.',
    )
  } else {
    const c2 = await updateRows(cfg, identities.admin, 'app_settings', 'id=eq.true', {
      inventory_authority: currentAuthority,
    })
    report.check(
      '4.12b',
      'admin UPDATE app_settings succeeds (1 row)',
      c2.ok && c2.rowCount === 1,
      `rowCount=${c2.rowCount} code=${c2.code} ${c2.message ?? ''}`,
    )
    report.notes.push(
      `4.12b wrote inventory_authority back to its own current value. The WHERE clause is ` +
        `identical to 4.4's (id=eq.true); only the SET value differs, and it differs in the ` +
        `direction that changes nothing. The affected-row count is 1 either way, so the policy ` +
        `is proven exactly as strongly with no live state change.`,
    )
  }

  const c3 = await rpc(cfg, identities.admin, 'apply_inventory_sync', {
    p_payload: { rows: [], matches: [] },
  })
  report.check(
    '4.12c',
    'admin apply_inventory_sync succeeds',
    c3.ok,
    `code=${c3.code} ${c3.message ?? ''}`,
  )

  return report
}
