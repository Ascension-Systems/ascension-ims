#!/usr/bin/env node
/**
 * Runs the four required attacks, in order, against a freshly reset local database.
 *
 * ASSERTIONS ARE MADE AGAINST A REAL DATABASE, NEVER AGAINST MOCKS.
 *
 * Exit code 0 only if all four pass. Any failure prints the failing assertion, the observed
 * SQLSTATE and the expected one.
 *
 * The summary block restates the Path A/B caveat verbatim, so the result is never reported
 * as stronger than the method supports.
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
      'VERIFICATION HARNESS — the four required attacks',
      '='.repeat(78),
      `Database path : ${db.label}`,
      `Migrations    : ${migrationFiles().length} files, applied from supabase/migrations/ in numeric order`,
      `Seed          : supabase/seed/0001 + 0002 (0003 excluded — it depends on a profile existing)`,
      'Target        : a LOCAL Postgres. Nothing here touches the hosted Supabase project.',
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
      'SUMMARY',
      '='.repeat(78),
      ...reports.map(
        (r) =>
          `  Attack ${r.number}  ${r.title.padEnd(42)} ${r.ok ? 'PASS' : 'FAIL'}  (${r.passed}/${r.total - r.skips})`,
      ),
      '',
      `  ${totalPassed}/${totalAssertions} assertions passed${totalSkipped ? `, ${totalSkipped} skipped` : ''}.`,
      '',
      '  Path caveat:',
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
