#!/usr/bin/env node
/**
 * `npm run verify:login-predicate` — assertion table 5.1, on its own.
 *
 * Compiles the application's real `app/login/auth-error.ts` and runs every row of
 * `verify/login/predicate-cases.ts` against it. NO NETWORK, NO CREDENTIALS, NO DATABASE, no
 * configuration of any kind: this is the part of suite 5 that can always run, so it is
 * reachable without booting anything and is cheap enough to be a pre-commit gate.
 *
 * It executes THE PRODUCT'S CODE, not a copy of it — see the header of
 * `verify/hosted/05-login-failure-modes.mjs` for why that is the property that matters.
 *
 * Exit code 0 only if every row held. A NOT EXECUTED (the predicate failed to compile) is not
 * a pass and exits non-zero, because this command's entire job is to execute those rows.
 */

import { Report, STATUS } from './lib/report.mjs'
import { compilePredicate, runPredicateTable } from './hosted/05-login-failure-modes.mjs'

const METHOD = `the product's own classifyAuthError is compiled standalone with tsc into
verify/.out and executed over every row of verify/login/predicate-cases.ts.
Nothing is mocked, nothing is mirrored, and nothing is contacted.`

async function main() {
  process.stdout.write(
    [
      '',
      '='.repeat(78),
      'PREDICATE TABLE (5.1) — magic-link error classification',
      '='.repeat(78),
      'Under test   : app/login/auth-error.ts, compiled and executed as-is',
      'Table        : verify/login/predicate-cases.ts',
      'Network      : none. Credentials: none. Database: none.',
      '',
    ].join('\n') + '\n',
  )

  const report = new Report(5, 'Magic-link error classification — the predicate table', METHOD)
  const compiled = await compilePredicate()
  runPredicateTable(report, compiled)
  report.print('app/login/auth-error.ts (compiled from source)', {
    labelWord: 'Target',
    kindWord: 'SUITE',
  })

  const notRun = report.results.filter((r) => r.status === STATUS.NOT_EXECUTED)
  if (notRun.length) {
    process.stdout.write(
      '\n  NOT EXECUTED — these did NOT run and must not be reported as passes:\n' +
        notRun.map((r) => `    ${r.id}  ${r.description}\n         reason: ${r.detail}`).join('\n') +
        '\n',
    )
  }

  process.stdout.write('\n')
  process.exitCode = report.failed === 0 && notRun.length === 0 ? 0 : 1
}

main().catch((err) => {
  process.stdout.write(`\nHARNESS ERROR: ${err?.stack ?? err?.message ?? err}\n`)
  process.exitCode = 1
})
