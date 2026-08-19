#!/usr/bin/env node
/**
 * `npm run verify:identities:remove` — removes every artefact the verification tooling
 * creates on the hosted project, in the order the foreign keys require, and prints what it
 * deleted.
 *
 * ------------------------------------------------------------------------------------
 * THE ORDER IS NOT COSMETIC. TWO FOREIGN KEYS BLOCK A NAIVE TEARDOWN.
 * ------------------------------------------------------------------------------------
 *   commitments.rep_id        REFERENCES profiles (id)              ON DELETE RESTRICT
 *   commitments (sku,location) REFERENCES inventory (sku, location) ON DELETE RESTRICT
 *
 * and one more that silently destroys the evidence if taken out of order:
 *
 *   inventory_sync_runs.run_by REFERENCES profiles (id)             ON DELETE SET NULL
 *
 * Deleting the auth users cascades their profiles rows, which NULLs `run_by` on every sync
 * run they performed — after which those rows can no longer be identified as artefacts at
 * all. So the sync runs are deleted BEFORE the users, never after.
 *
 * 1. commitments at location 'kyv-verify' (and 'kyv-verify-2')
 * 2. any remaining commitments owned by the two test identities
 * 3. inventory_sync_runs whose run_by is a test identity      <- before step 5
 * 4. products LIKE 'KYV-%'  (cascades public.inventory)
 * 5. the two auth users     (cascades public.profiles)
 *
 * It touches no SEA-* row and never deletes a commitment it cannot attribute to the harness.
 */

import { loadConfig, configProofLines, NO_CONFIG, missingConfigDetail } from '../verify/hosted/lib/config.mjs'
import { buildIdentities, selectRows, deleteRows } from '../verify/hosted/lib/client.mjs'
import { serviceClient, findUserByEmail, REP_EMAIL, ADMIN_EMAIL, TEST_EMAILS } from '../verify/hosted/lib/identity.mjs'

const write = (s) => process.stdout.write(s)
const q = encodeURIComponent

async function main() {
  const cfg = loadConfig()

  write(
    [
      '',
      '='.repeat(78),
      'REMOVE TEST IDENTITIES AND VERIFICATION ARTEFACTS',
      '='.repeat(78),
      ...configProofLines(cfg),
      '',
    ].join('\n') + '\n',
  )

  if (!cfg.ok) {
    write(`${NO_CONFIG}\n\n${missingConfigDetail(cfg)}\n`)
    process.exitCode = 1
    return
  }

  const identities = buildIdentities(cfg)
  const svc = serviceClient(cfg)

  /* --- locate the test identities first, while their profiles still exist --- */
  const users = {}
  for (const email of TEST_EMAILS) {
    try {
      users[email] = await findUserByEmail(svc, email)
    } catch (err) {
      write(`FAILED: could not query the GoTrue admin API: ${err?.message ?? err}\n`)
      process.exitCode = 1
      return
    }
  }
  const uids = TEST_EMAILS.map((e) => users[e]?.id).filter(Boolean)

  const removed = []
  const problems = []

  const step = async (label, fn) => {
    try {
      const n = await fn()
      removed.push(`${label}: ${n}`)
    } catch (err) {
      problems.push(`${label}: FAILED — ${err?.message ?? err}`)
    }
  }

  /* 1 + 2 — commitments, before anything they point at ------------------- */
  await step("commitments at location 'kyv-verify'", async () => {
    const res = await deleteRows(cfg, identities.service, 'commitments', 'location=eq.kyv-verify')
    if (!res.ok) throw new Error(`${res.code} ${res.message}`)
    return res.rowCount
  })

  await step("commitments at location 'kyv-verify-2'", async () => {
    const res = await deleteRows(cfg, identities.service, 'commitments', 'location=eq.kyv-verify-2')
    if (!res.ok) throw new Error(`${res.code} ${res.message}`)
    return res.rowCount
  })

  if (uids.length) {
    await step('commitments owned by a test identity (any location)', async () => {
      const res = await deleteRows(
        cfg,
        identities.service,
        'commitments',
        `rep_id=in.(${uids.map(q).join(',')})`,
      )
      if (!res.ok) throw new Error(`${res.code} ${res.message}`)
      return res.rowCount
    })

    /* 3 — sync runs, BEFORE the users, or run_by is NULLed and they become
           unidentifiable ------------------------------------------------- */
    await step('inventory_sync_runs performed by a test identity', async () => {
      const res = await deleteRows(
        cfg,
        identities.service,
        'inventory_sync_runs',
        `run_by=in.(${uids.map(q).join(',')})`,
      )
      if (!res.ok) throw new Error(`${res.code} ${res.message}`)
      return res.rowCount
    })
  } else {
    removed.push('commitments owned by a test identity: 0 (no test identity exists)')
    removed.push('inventory_sync_runs performed by a test identity: 0 (no test identity exists)')
  }

  /* 4 — products, which cascades inventory ------------------------------- */
  await step("products LIKE 'KYV-%' (cascades public.inventory)", async () => {
    const res = await deleteRows(cfg, identities.service, 'products', 'sku=like.KYV-*')
    if (!res.ok) throw new Error(`${res.code} ${res.message}`)
    return res.rowCount
  })

  /* 5 — the auth users, which cascades public.profiles -------------------- */
  for (const email of TEST_EMAILS) {
    const user = users[email]
    if (!user) {
      removed.push(`auth user ${email}: 0 (not present)`)
      continue
    }
    try {
      const { error } = await svc.auth.admin.deleteUser(user.id)
      if (error) throw new Error(error.message)
      removed.push(`auth user ${email}: 1 (cascades public.profiles)`)
    } catch (err) {
      problems.push(`auth user ${email}: FAILED — ${err?.message ?? err}`)
    }
  }

  /* --- confirmation reads ------------------------------------------------ */
  const leftoverProducts = await selectRows(cfg, identities.service, 'products', 'select=sku&sku=like.KYV-*')
  const leftoverCommits = await selectRows(
    cfg,
    identities.service,
    'commitments',
    'select=id&location=eq.kyv-verify',
  )
  const allCommits = await selectRows(cfg, identities.service, 'commitments', 'select=sku,qty,state,note')

  write(
    [
      'REMOVED',
      ...removed.map((r) => `  ${r}`),
      '',
      ...(problems.length ? ['PROBLEMS', ...problems.map((p) => `  ${p}`), ''] : []),
      'CONFIRMATION',
      `  products LIKE 'KYV-%' remaining ......... ${leftoverProducts.ok ? leftoverProducts.rowCount : `unreadable (${leftoverProducts.code})`}`,
      `  commitments at 'kyv-verify' remaining ... ${leftoverCommits.ok ? leftoverCommits.rowCount : `unreadable (${leftoverCommits.code})`}`,
      `  commitments remaining in total .......... ${allCommits.ok ? allCommits.rowCount : `unreadable (${allCommits.code})`}`,
      ...(allCommits.ok
        ? allCommits.rows.map((r) => `      ${r.sku} qty ${r.qty} ${r.state} — ${r.note ?? ''}`)
        : []),
      '',
      '  The demo delta (SEA-9007 / 6 / pending) should be the only commitment left.',
      '',
    ].join('\n') + '\n',
  )

  if (problems.length) {
    write(
      'Some steps failed. README.md, step 11, carries the equivalent SQL for the dashboard\n' +
        'editor, in the order the foreign keys require.\n',
    )
    process.exitCode = 1
    return
  }

  write(`Done. ${REP_EMAIL} and ${ADMIN_EMAIL} are gone, with their profiles.\n`)
}

main().catch((err) => {
  write(`\nERROR: ${err?.stack ?? err?.message ?? err}\n`)
  process.exitCode = 1
})
