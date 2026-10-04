#!/usr/bin/env node
/**
 * `npm run verify:local` — the attack suites (1, 2, 4) against an EPHEMERAL LOCAL PostgreSQL server.
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
 * Exit code 0 only if all four pass AND the emitted assertion ids match verify/lib/manifest.mjs
 * in both directions.
 */

import { resolveDatabase, shutdownDatabase, PATH_CAVEAT, migrationFiles, LOCAL_REWRITE_NOTE } from './lib/harness.mjs'
import { STATUS } from './lib/report.mjs'
import { MANIFEST } from './lib/manifest.mjs'
import {
  checkDrift,
  renderDrift,
  computeDisposition,
  renderDispositionBlock,
  checkManifestIntegrity,
  checkDispositionSums,
  renderInvariantFailure,
} from './lib/disposition.mjs'
import attack1 from './01-rls-bypass.mjs'
import attack2 from './02-quickbooks-sole-source.mjs'
import attack4 from './04-role-enforcement.mjs'

const ATTACKS = [attack1, attack2, attack4]

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
      'VERIFICATION HARNESS (LOCAL) — the required attacks (1, 2, 4)',
      '='.repeat(78),
      PATH_CAVEAT.trimEnd().replace(/^\n/, ''),
      '',
      `Database path : ${db.label}`,
      `Migrations    : ${migrationFiles().length} files, applied from supabase/migrations/ in numeric order`,
      `Seed          : supabase/seed/0001 + 0002 (0003 excluded — it depends on a profile existing)`,
      LOCAL_REWRITE_NOTE,
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
  const totalExecuted = reports.reduce((n, r) => n + r.executed, 0)
  const totalPassed = reports.reduce((n, r) => n + r.passed, 0)
  const totalStatic = reports.reduce((n, r) => n + r.statics, 0)
  const totalNotRun = reports.reduce((n, r) => n + r.notRun, 0)

  process.stdout.write(
    [
      '',
      '='.repeat(78),
      'SUMMARY — npm run verify:local',
      '='.repeat(78),
      ...reports.map(
        (r) =>
          `  Attack ${r.number}  ${r.title.padEnd(42)} ${r.ok ? 'PASS' : 'FAIL'}  (${r.passed}/${r.executed} executed` +
          `${r.statics ? `, ${r.statics} static` : ''}${r.notRun ? `, ${r.notRun} not executed` : ''})`,
      ),
      '',
      `  ${totalPassed}/${totalExecuted} POLICY-LOGIC assertions passed against the ephemeral local`,
      '  PostgreSQL server' +
        `${totalStatic ? `, ${totalStatic} STATIC` : ''}` +
        `${totalNotRun ? `, ${totalNotRun} NOT EXECUTED` : ''}. THIS IS NOT A HOSTED RESULT and must not be`,
      '  quoted as one. See the scope statement below.',
      '',
      PATH_CAVEAT.trimEnd(),
      '',
      RLS_SEMANTICS_NOTE.trimEnd(),
      '',
    ].join('\n') + '\n',
  )

  if (totalNotRun) {
    process.stdout.write(
      [
        '  NOT EXECUTED — these did NOT run and must not be reported as passes:',
        ...reports.flatMap((r) =>
          r.results
            .filter((x) => x.status === STATUS.NOT_EXECUTED)
            .map((x) => `    ${x.id}  ${x.description}\n         reason: ${x.detail}`),
        ),
        '',
      ].join('\n') + '\n',
    )
  }

  /* ---------------------------------------------------------------- *
   * Manifest drift. Both directions, every run. See verify/lib/manifest.mjs.
   * ---------------------------------------------------------------- */
  const drift = checkDrift(MANIFEST, reports, 'local')
  process.stdout.write(renderDrift(drift))

  /* ---------------------------------------------------------------- *
   * The manifest's own integrity and the sum invariant. Neither needs
   * config, network or a database. renderScope PRINTS the sum; these
   * two ASSERT it, which is not the same thing.
   * ---------------------------------------------------------------- */
  const totals = computeDisposition(MANIFEST)
  const integrity = checkManifestIntegrity(MANIFEST)
  if (!integrity.ok) {
    process.stdout.write(
      renderInvariantFailure('MANIFEST INTEGRITY — the declared inventory is malformed.', integrity.problems),
    )
  }
  const sums = checkDispositionSums(totals, MANIFEST)
  if (!sums.ok) {
    process.stdout.write(
      renderInvariantFailure('DISPOSITION SUM INVARIANT — the printed figures do not reconcile.', sums.problems),
    )
  }

  /* ---------------------------------------------------------------- *
   * The one authoritative disposition, computed — never hand-counted.
   * ---------------------------------------------------------------- */
  process.stdout.write(renderDispositionBlock(totals) + '\n')

  process.exitCode = failed.length === 0 && drift.ok && integrity.ok && sums.ok ? 0 : 1
}

// EXIT EXPLICITLY. embedded-postgres registers async-exit-hook, which calls process.exit(0)
// on beforeExit and discards process.exitCode — so a HARNESS ERROR or a failed attack used to
// exit 0, and CI would have read a broken suite as a pass. Passing the code to process.exit
// ourselves is what makes the non-zero exit real.
// The empty write's callback fires once everything queued before it has flushed, so piped
// output (CI logs) is not truncated by the exit.
const exitAfterFlush = (code) => process.stdout.write('', () => process.exit(code))

main()
  .then(() => exitAfterFlush(process.exitCode ?? 0))
  .catch(async (err) => {
    await shutdownDatabase()
    process.stdout.write(`\nHARNESS ERROR: ${err.stack ?? err.message}\n`)
    exitAfterFlush(1)
  })
