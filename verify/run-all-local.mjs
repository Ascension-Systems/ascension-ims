#!/usr/bin/env node
/**
 * `npm run verify:local` — the four attacks against an EPHEMERAL LOCAL PostgreSQL server.
 *
 * ------------------------------------------------------------------------------------
 * THIS IS NOT THE HOSTED PATH AND IS NEVER A CLAIM ABOUT THE HOSTED PROJECT.
 * ------------------------------------------------------------------------------------
 * `npm run verify` targets the configured hosted Supabase project over HTTPS and NEVER
 * falls back to this file. This file is reachable only by asking for it by name. It needs
 * none of the three Supabase environment variables and contacts nothing remote.
 *
 * It survives because it is the only place attack 2a's deterministic lock interleaving can
 * run: PostgREST has no open transactions, so "B's call is still unsettled 500 ms later"
 * — the direct evidence of blocking rather than of a lucky race — is unavailable over the
 * hosted channel at any level of concurrency.
 *
 * ASSERTIONS ARE MADE AGAINST A REAL DATABASE, NEVER AGAINST MOCKS.
 *
 * Exit code 0 only if all four pass.
 */

import { resolveDatabase, shutdownDatabase, PATH_CAVEAT, migrationFiles } from './lib/harness.mjs'
import attack1 from './01-rls-bypass.mjs'
import attack2 from './02-concurrent-last-unit.mjs'
import attack3 from './03-stale-baseline.mjs'
import attack4 from './04-role-enforcement.mjs'

const ATTACKS = [attack1, attack2, attack3, attack4]

const RLS_SEMANTICS_NOTE = `
  A NOTE ON HOW A REFUSAL IS ASSERTED. Postgres raises 42501 for an INSERT that violates a
  WITH CHECK policy, and for any command whose table GRANT the role lacks. It does NOT raise
  for an UPDATE or DELETE that an RLS USING clause filters out — those report 0 rows and no
  error. This harness does not accept "no error and 0 rows" on its own. For every filtered
  write it asserts three things together: 0 rows affected, the target row unchanged on an
  independent re-read, and the IDENTICAL statement succeeding as admin. That is strictly
  stronger evidence than a bare SQLSTATE check, and it is what distinguishes a working policy
  from a blanket denial.`

async function main() {
  const db = await resolveDatabase()

  process.stdout.write(
    [
      '',
      '='.repeat(78),
      'VERIFICATION HARNESS (LOCAL) — the four required attacks',
      '='.repeat(78),
      PATH_CAVEAT.trimEnd().replace(/^\n/, ''),
      '',
      `Database path : ${db.label}`,
      `Migrations    : ${migrationFiles().length} files, applied from supabase/migrations/ in numeric order`,
      `Seed          : supabase/seed/0001 + 0002 (0003 excluded — it depends on a profile existing)`,
      'Target        : a LOCAL Postgres. Nothing here touches the hosted Supabase project.',
      'Hosted path   : `npm run verify`. This command is not a substitute for it and never',
      '                falls back to it, nor it to this.',
      '',
    ].join('\n') + '\n',
  )

  const reports = []
  let hardError = null

  try {
    for (const attack of ATTACKS) {
      const report = await attack(db)
      report.print(db.label)
      reports.push(report)
    }
  } catch (err) {
    hardError = err
  } finally {
    await shutdownDatabase()
  }

  if (hardError) {
    process.stdout.write(`\nHARNESS ERROR: ${hardError.stack ?? hardError.message}\n`)
    process.exitCode = 1
    return
  }

  const failed = reports.filter((r) => !r.ok)
  const totalAssertions = reports.reduce((n, r) => n + r.total - r.skips, 0)
  const totalPassed = reports.reduce((n, r) => n + r.passed, 0)
  const totalSkipped = reports.reduce((n, r) => n + r.skips, 0)

  process.stdout.write(
    [
      '',
      '='.repeat(78),
      'SUMMARY — npm run verify:local',
      '='.repeat(78),
      ...reports.map(
        (r) =>
          `  Attack ${r.number}  ${r.title.padEnd(42)} ${r.ok ? 'PASS' : 'FAIL'}  (${r.passed}/${r.total - r.skips})`,
      ),
      '',
      `  ${totalPassed}/${totalAssertions} POLICY-LOGIC assertions passed against the ephemeral local`,
      '  PostgreSQL server' +
        `${totalSkipped ? `, ${totalSkipped} skipped` : ''}. THIS IS NOT A HOSTED RESULT and must not be`,
      '  quoted as one. See the scope statement below.',
      '',
      PATH_CAVEAT.trimEnd(),
      '',
      RLS_SEMANTICS_NOTE.trimEnd(),
      '',
    ].join('\n') + '\n',
  )

  if (totalSkipped) {
    process.stdout.write(
      [
        '  SKIPPED ASSERTIONS — these were NOT run and must not be reported as passes:',
        ...reports.flatMap((r) =>
          r.results
            .filter((x) => x.status === 'SKIP')
            .map((x) => `    ${x.id}  ${x.description}\n         reason: ${x.detail}`),
        ),
        '',
      ].join('\n') + '\n',
    )
  }

  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch(async (err) => {
  await shutdownDatabase()
  process.stdout.write(`\nHARNESS ERROR: ${err.stack ?? err.message}\n`)
  process.exitCode = 1
})
