/**
 * Report — the assertion ledger shared by BOTH runners.
 *
 * THIS FILE TOUCHES NO DATABASE. It is the only code shared between
 * `npm run verify` (hosted, over HTTPS) and `npm run verify:local` (embedded Postgres),
 * deliberately: a single driver parameterised over `hosted | local` would put a hosted
 * NOT EXECUTED and a local PASS one boolean apart in the same code path.
 *
 * ------------------------------------------------------------------------------------
 * THE ONE RULE: NEVER PRINT PASS FOR ANYTHING NOT ACTUALLY EXECUTED.
 * ------------------------------------------------------------------------------------
 * FOUR statuses, and there is no fifth:
 *
 *   PASS          executed against the target, and it held
 *   FAIL          executed against the target, and it did not hold
 *   STATIC        a source-file assertion. Real, but it asserts the MIGRATION SOURCE,
 *                 not deployed state. Counted separately and never as a live pass.
 *   NOT EXECUTED  did not run, with a printed reason. Never counted as a pass.
 *
 * `SKIP` IS DELETED AND DOES NOT COME BACK. It was a fifth label that read like a decision
 * ("we chose not to") when it meant the same thing as NOT EXECUTED ("it did not run"), and a
 * status that softens a non-execution is exactly how a non-result gets quoted as a result.
 * `docs/VERIFICATION.md` says four states; this file now says four states; there is no third
 * opinion to reconcile.
 *
 * Totals are computed from what actually ran. Nothing here carries a hard-coded expected
 * assertion count, and nothing may be seeded with one.
 */

export const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  STATIC: 'STATIC',
  NOT_EXECUTED: 'NOT EXECUTED',
}

/** Reasons a run is blocked outright, as opposed to an assertion that is merely unreachable. */
export const NOT_EXECUTED_NO_CONFIG = 'NOT EXECUTED — no Supabase configuration'
export const NOT_EXECUTED_NO_SCHEMA = 'NOT EXECUTED — schema not applied'

export class Report {
  constructor(number, title, method) {
    this.number = number
    this.title = title
    this.method = method
    this.results = []
    /** Free-form lines printed under the RESULT line and repeated in the run summary. */
    this.notes = []
    /** Set when the whole attack could not be attempted (config, reachability, schema). */
    this.blocked = null
  }

  /* ---------------------------------------------------------------- *
   * Recording
   * ---------------------------------------------------------------- */

  pass(id, description) {
    this.results.push({ id, description, status: STATUS.PASS, kind: 'live' })
  }

  fail(id, description, detail) {
    this.results.push({ id, description, status: STATUS.FAIL, kind: 'live', detail })
  }

  /**
   * The assertion did not run. `reason` is printed every time, in the per-attack block and
   * again in the run summary. `blocking: true` means the run itself is invalid (missing
   * configuration, unreachable endpoint, schema not applied) and the process must exit
   * non-zero; `blocking: false` means the assertion is permanently unreachable over this
   * channel (raw SQL, open transactions, pg_catalog) or was not opted into, which is not a
   * failure of the system under test.
   */
  notExecuted(id, description, reason, { blocking = false } = {}) {
    this.results.push({
      id,
      description,
      status: STATUS.NOT_EXECUTED,
      kind: 'notrun',
      detail: reason,
      blocking,
    })
  }

  /**
   * DELETED. LEFT AS A THROWING STUB ON PURPOSE.
   *
   * A missing method throws TypeError, which is an accident of JavaScript rather than a
   * decision. This throws a message that names the correct status, so the fifth state cannot
   * rot back in through a copy-paste from an older harness.
   */
  skip(id) {
    throw new Error(
      `Report.skip() is deleted and does not come back. Assertion ${id ?? '(unnamed)'} must ` +
        `use notExecuted(id, description, reason) and report as NOT EXECUTED. SKIP was a fifth ` +
        `label that read like a decision ("we chose not to") when it meant "it did not run", and ` +
        `a status that softens a non-execution is exactly how a non-result gets quoted as a ` +
        `result. There are four statuses: PASS, FAIL, STATIC, NOT EXECUTED.`,
    )
  }

  /**
   * A source-file assertion. It really ran, but against the committed migration text — not
   * against the deployed database. `note` is printed with every occurrence so the
   * distinction cannot be lost between the assertion and the summary.
   */
  staticCheck(id, description, condition, note, detail = '') {
    this.results.push({
      id,
      description,
      status: condition ? STATUS.STATIC : STATUS.FAIL,
      kind: 'static',
      note,
      detail: condition ? '' : detail,
    })
    return condition
  }

  /** Generic assertion. `detail` is printed on failure. */
  check(id, description, condition, detail = '') {
    if (condition) this.pass(id, description)
    else this.fail(id, description, detail)
    return condition
  }

  /** Asserts a refusal: the operation must have failed with `expectedCode`. */
  refused(id, description, outcome, expectedCode) {
    const ok = outcome.ok === false && outcome.code === expectedCode
    return this.check(
      id,
      description,
      ok,
      outcome.ok
        ? `expected SQLSTATE ${expectedCode}, but the statement SUCCEEDED (${outcome.rowCount} rows affected)`
        : `expected SQLSTATE ${expectedCode}, observed ${outcome.code}: ${outcome.message}`,
    )
  }

  /** Asserts an operation succeeded. Used by the control cases. */
  allowed(id, description, outcome) {
    return this.check(
      id,
      description,
      outcome.ok === true,
      outcome.ok ? '' : `expected success, observed ${outcome.code}: ${outcome.message}`,
    )
  }

  equals(id, description, actual, expected) {
    return this.check(
      id,
      description,
      Object.is(actual, expected) || String(actual) === String(expected),
      `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
    )
  }

  /* ---------------------------------------------------------------- *
   * Counters — all derived, none seeded
   * ---------------------------------------------------------------- */

  get passed() {
    return this.results.filter((r) => r.status === STATUS.PASS).length
  }

  get failed() {
    return this.results.filter((r) => r.status === STATUS.FAIL).length
  }

  get statics() {
    return this.results.filter((r) => r.status === STATUS.STATIC).length
  }

  get notRun() {
    return this.results.filter((r) => r.status === STATUS.NOT_EXECUTED).length
  }

  /** Assertions actually executed against the target: PASS + FAIL, excluding static ones. */
  get executed() {
    return this.results.filter((r) => r.kind === 'live').length
  }

  get total() {
    return this.results.length
  }

  get ok() {
    return this.failed === 0 && !this.blocked
  }

  /** True when this attack could not be attempted at all. */
  get isBlocked() {
    return Boolean(this.blocked) || this.results.some((r) => r.blocking === true)
  }

  /* ---------------------------------------------------------------- *
   * Printing
   * ---------------------------------------------------------------- */

  /**
   * `kindWord` exists so suite 5 can print as SUITE and not as ATTACK. The brief requires four
   * attacks, `docs/VERIFICATION.md` is structured around those four, and a regression suite
   * printing itself as "ATTACK 5" would quietly turn four into five.
   */
  print(targetLabel, { labelWord = 'Path', kindWord = 'ATTACK' } = {}) {
    const width = 58
    const lines = []
    lines.push('')
    lines.push(`${kindWord} ${this.number} — ${this.title}`)
    lines.push(`  ${labelWord}:${' '.repeat(Math.max(1, 8 - labelWord.length))}${targetLabel}`)
    lines.push(`  Method: ${this.method.trim().split('\n').join('\n          ')}`)
    for (const r of this.results) {
      const dots = '.'.repeat(Math.max(3, width - r.id.length - r.description.length))
      lines.push(`  ${r.id} ${r.description} ${dots} ${r.status}`)
      if (r.status !== STATUS.PASS && r.detail) {
        lines.push(`       ↳ ${r.detail}`)
      }
      if (r.note) {
        lines.push(`       ↳ ${r.note}`)
      }
    }

    if (this.blocked) {
      // Not FAIL: nothing was attempted, so nothing failed. The distinction is the point.
      lines.push(`  RESULT: ${this.blocked}`)
    } else {
      const parts = [`${this.passed}/${this.executed} executed`]
      if (this.statics) parts.push(`${this.statics} STATIC`)
      if (this.notRun) parts.push(`${this.notRun} NOT EXECUTED`)
      lines.push(`  RESULT: ${this.ok ? 'PASS' : 'FAIL'} (${parts.join(', ')})`)
    }
    for (const note of this.notes ?? []) {
      lines.push(`  NOTE:   ${note}`)
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
}

/**
 * Builds a report whose every assertion is NOT EXECUTED for one blocking reason. Used when
 * configuration is absent, the endpoint is unreachable, or the schema is not applied — so
 * the runner still prints a per-attack verdict rather than an empty result set.
 */
export function blockedReport(number, title, method, reason, { kindWord = 'attack' } = {}) {
  const report = new Report(number, title, method)
  report.blocked = reason
  report.notExecuted(`${number}.*`, `every assertion in ${kindWord} ${number}`, reason, {
    blocking: true,
  })
  return report
}
