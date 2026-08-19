/**
 * THE ONE AUTHORITATIVE DISPOSITION — computed, never hand-counted.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT A PARAGRAPH
 * ------------------------------------------------------------------------------------
 * The previous answers to "how many assertions are there, and which of them can actually
 * run" were produced by reading `docs/VERIFICATION.md` and counting. That cannot work: 35 of
 * the ids appear there in countable form and the rest do not appear at all, one call site
 * generates six assertions from a loop, and one table row is three assertions in the code. A
 * number that describes generated output must itself be generated.
 *
 * So: `verify/lib/manifest.mjs` declares the inventory, this file derives every figure from
 * it, both runners print the result, `checkDrift` reconciles the declaration against what the
 * run actually emitted IN BOTH DIRECTIONS, and `npm run check:disposition` reconciles the
 * generated block against the copy committed in the document. Three-way anti-drift:
 * code <-> manifest, manifest <-> doc, and doc prose <-> nothing, because no hand-written
 * count is left in the prose to drift.
 *
 * NOTHING HERE IS HARD-CODED. If a figure below disagrees with a number written in a
 * document, the document is wrong.
 */

import { MANIFEST, ATTACK_SUITES, REGRESSION_SUITES, NON_INVENTORY_IDS, NON_INVENTORY_PATTERN } from './manifest.mjs'

const EXECUTABLE = new Set(['live', 'conditional'])
const isExecutable = (state) => EXECUTABLE.has(state)

/* ==================================================================== *
 * Computation
 * ==================================================================== */

function scope(entries, label) {
  const count = (fn) => entries.filter(fn).length
  const idsWhere = (fn) => entries.filter(fn).map((e) => e.id)

  const both = idsWhere((e) => isExecutable(e.hosted) && isExecutable(e.local))
  const localOnly = idsWhere((e) => !isExecutable(e.hosted) && isExecutable(e.local))
  const remoteOnly = idsWhere((e) => isExecutable(e.hosted) && !isExecutable(e.local))
  const neither = idsWhere((e) => !isExecutable(e.hosted) && !isExecutable(e.local))

  return {
    label,
    total: entries.length,
    hosted: {
      live: count((e) => e.hosted === 'live'),
      conditional: count((e) => e.hosted === 'conditional'),
      executable: count((e) => isExecutable(e.hosted)),
      static: count((e) => e.hosted === 'static'),
      notExecuted: count((e) => e.hosted === 'not-executed'),
      absent: count((e) => e.hosted === 'absent'),
    },
    local: {
      live: count((e) => e.local === 'live'),
      conditional: count((e) => e.local === 'conditional'),
      executable: count((e) => isExecutable(e.local)),
      static: count((e) => e.local === 'static'),
      notExecuted: count((e) => e.local === 'not-executed'),
      absent: count((e) => e.local === 'absent'),
    },
    both,
    localOnly,
    remoteOnly,
    neither,
    optIn: entries.filter((e) => e.optIn).map((e) => ({ id: e.id, runner: e.optIn })),
    alsoRuns: [...new Set(entries.filter((e) => e.alsoRuns).map((e) => e.alsoRuns))].map(
      (runner) => ({ runner, ids: idsWhere((e) => e.alsoRuns === runner) }),
    ),
    bySuite: [...new Set(entries.map((e) => e.suite))].sort().map((n) => ({
      suite: n,
      total: count((e) => e.suite === n),
      hostedExecutable: count((e) => e.suite === n && isExecutable(e.hosted)),
      hostedStatic: count((e) => e.suite === n && e.hosted === 'static'),
      hostedNotExecuted: count((e) => e.suite === n && e.hosted === 'not-executed'),
      hostedAbsent: count((e) => e.suite === n && e.hosted === 'absent'),
      localExecutable: count((e) => e.suite === n && isExecutable(e.local)),
      localAbsent: count((e) => e.suite === n && e.local === 'absent'),
    })),
  }
}

export function computeDisposition(manifest = MANIFEST) {
  return {
    attacks: scope(
      manifest.filter((e) => ATTACK_SUITES.includes(e.suite)),
      'THE FOUR REQUIRED ATTACKS (suites 1-4)',
    ),
    regression: scope(
      manifest.filter((e) => REGRESSION_SUITES.includes(e.suite)),
      'REGRESSION SUITE 5 — magic-link request failure modes',
    ),
  }
}

/* ==================================================================== *
 * Rendering
 * ==================================================================== */

const WIDTH = 62
const row = (label, value) =>
  `    ${label} ${'.'.repeat(Math.max(3, WIDTH - label.length))} ${value}`

/** Wraps a long id list so the generated block stays readable in a terminal and in the doc. */
function wrapList(ids, indent) {
  if (!ids.length) return [`${indent}none`]
  const lines = []
  let current = ''
  for (const id of ids) {
    const next = current ? `${current}, ${id}` : id
    if (next.length + indent.length > 92) {
      lines.push(indent + current + ',')
      current = id
    } else {
      current = next
    }
  }
  lines.push(indent + current)
  return lines
}

function renderScope(s) {
  const lines = [`  ${s.label}`, '']
  lines.push(row('Total distinct assertion ids', s.total))
  lines.push(row('Executable remotely  (npm run verify)', s.hosted.executable))
  lines.push(row('  of which conditional on a precondition', s.hosted.conditional))
  lines.push(row('STATIC — asserts the migration source, not deployed', s.hosted.static))
  lines.push(row('NOT EXECUTED on the hosted path', s.hosted.notExecuted))
  if (s.hosted.absent) lines.push(row('Absent from the hosted path', s.hosted.absent))
  lines.push('')
  lines.push(row('Executes live ONLY under npm run verify:local', s.localOnly.length))
  lines.push(row('Executes live ONLY under npm run verify', s.remoteOnly.length))
  lines.push(row('Executes live on BOTH paths', s.both.length))
  lines.push(row('Executes live on NEITHER path', s.neither.length))
  lines.push('')
  lines.push(
    `    ${s.both.length} + ${s.localOnly.length} + ${s.remoteOnly.length} + ` +
      `${s.neither.length} = ${s.both.length + s.localOnly.length + s.remoteOnly.length + s.neither.length}` +
      ` (declared total ${s.total})`,
  )
  lines.push('')
  lines.push('    Remote-only :')
  lines.push(...wrapList(s.remoteOnly, '      '))
  lines.push('    Neither     :')
  lines.push(...wrapList(s.neither, '      '))
  for (const a of s.alsoRuns) {
    lines.push(`    Also run by \`npm run ${a.runner}\` (${a.ids.length} ids):`)
    lines.push(...wrapList(a.ids, '      '))
  }
  for (const o of s.optIn) {
    lines.push(`    Opt-in      : ${o.id} executes under \`npm run ${o.runner}\``)
  }
  lines.push('')
  lines.push('    Per suite (hosted / local, executable live or conditional):')
  for (const b of s.bySuite) {
    lines.push(
      `      suite ${b.suite}: ${b.total} ids — hosted ${b.hostedExecutable} executable, ` +
        `${b.hostedStatic} STATIC, ${b.hostedNotExecuted} NOT EXECUTED` +
        `${b.hostedAbsent ? `, ${b.hostedAbsent} absent` : ''}` +
        ` | local ${b.localExecutable} executable` +
        `${b.localAbsent ? `, ${b.localAbsent} absent` : ''}`,
    )
  }
  return lines
}

export function renderDispositionBlock(totals) {
  return [
    'ASSERTION DISPOSITION — computed from verify/lib/manifest.mjs by',
    'verify/lib/disposition.mjs. Nothing here is hand-counted, and no count of anything',
    'the code can count appears in the prose of docs/VERIFICATION.md.',
    '',
    ...renderScope(totals.attacks),
    '',
    ...renderScope(totals.regression),
    '',
    '  READ "executable remotely" AS A MAXIMUM, NOT A PROMISE. It counts the conditional',
    '  assertions as executable, and each of those has a precondition that can fail to hold:',
    '  PORTAL_BASE_URL set, the running app accepting the harness-minted session, app_settings',
    '  readable, service_role holding the UPDATE grant it needs. When a precondition does not',
    '  hold the assertion is reported NOT EXECUTED with its reason and is never counted as a',
    '  pass. The per-run figures the runner prints below its attacks are the actual result;',
    '  this block is the inventory those results are drawn from.',
  ].join('\n')
}

export const DISPOSITION_BEGIN =
  '<!-- DISPOSITION:BEGIN — generated by `npm run verify:disposition`. Do not edit by hand. -->'
export const DISPOSITION_END = '<!-- DISPOSITION:END -->'

/** The exact text of the generated region in docs/VERIFICATION.md, markers included. */
export function renderDocRegion(totals) {
  return [DISPOSITION_BEGIN, '', '```', renderDispositionBlock(totals), '```', '', DISPOSITION_END].join(
    '\n',
  )
}

/* ==================================================================== *
 * Drift — both directions, every run
 * ==================================================================== */

/**
 * Compares the manifest against the ids a run actually emitted.
 *
 *   undeclared : emitted by the run, absent from the manifest
 *   missing    : declared for this path, never emitted
 *
 * `missing` excludes ids whose declared state for this path is `absent` — that is the state
 * that explains the absence, and it is the only thing that does. A suite that aborted before
 * completing (a setup failure, or an attack that raised) is excluded from `missing` and
 * named, because its ids are missing for a reason the run already reported loudly.
 *
 * This is the mechanism that stops the manifest becoming a second stale document. If it ever
 * disagrees with the code, the CODE is right and the manifest is what gets edited.
 */
export function checkDrift(manifest, reports, path) {
  if (path !== 'hosted' && path !== 'local') {
    throw new Error(`checkDrift: path must be 'hosted' or 'local', got ${JSON.stringify(path)}`)
  }

  const blocked = reports.filter((r) => r.blocked)
  if (blocked.length === reports.length && reports.length > 0) {
    return {
      ok: true,
      checked: false,
      reason:
        'not checked: every suite was blocked before it ran, so there is nothing to reconcile.',
      undeclared: [],
      missing: [],
      incompleteSuites: [],
    }
  }

  const emitted = new Set()
  const incompleteSuites = []
  for (const report of reports) {
    if (report.blocked) {
      incompleteSuites.push(report.number)
      continue
    }
    let incomplete = false
    for (const r of report.results) {
      if (NON_INVENTORY_PATTERN.test(r.id) || NON_INVENTORY_IDS.includes(r.id)) {
        incomplete = true
        continue
      }
      emitted.add(r.id)
    }
    // An attack that raised mid-way emits `<n>.!`; a setup failure emits `1.0` and returns.
    if (incomplete) incompleteSuites.push(report.number)
  }

  const declared = new Map(manifest.map((e) => [e.id, e]))
  const suitesRun = new Set(reports.map((r) => r.number))

  const undeclared = [...emitted].filter((id) => !declared.has(id)).sort()
  const missing = manifest
    .filter(
      (e) =>
        suitesRun.has(e.suite) &&
        !incompleteSuites.includes(e.suite) &&
        e[path] !== 'absent' &&
        !emitted.has(e.id),
    )
    .map((e) => e.id)

  return {
    ok: undeclared.length === 0 && missing.length === 0,
    checked: true,
    reason: null,
    undeclared,
    missing,
    incompleteSuites: [...new Set(incompleteSuites)].sort(),
  }
}

export function renderDrift(drift) {
  if (!drift.checked) {
    return `\n  MANIFEST DRIFT CHECK: ${drift.reason}\n`
  }
  if (drift.ok) {
    return (
      '\n  MANIFEST: every assertion id emitted by this run is declared in ' +
      'verify/lib/manifest.mjs,\n            and every id declared for this path was emitted. No drift.' +
      (drift.incompleteSuites.length
        ? `\n            (suite${drift.incompleteSuites.length > 1 ? 's' : ''} ` +
          `${drift.incompleteSuites.join(', ')} did not complete, so ${drift.incompleteSuites.length > 1 ? 'their' : 'its'} ` +
          `ids were not required)`
        : '') +
      '\n'
    )
  }
  const lines = ['', '  ' + '!'.repeat(74), '  MANIFEST DRIFT — the declared inventory and the run disagree.']
  if (drift.undeclared.length) {
    lines.push('')
    lines.push('  Emitted by this run but NOT DECLARED in verify/lib/manifest.mjs:')
    for (const id of drift.undeclared) lines.push(`    ${id}`)
  }
  if (drift.missing.length) {
    lines.push('')
    lines.push('  Declared for this path but NOT EMITTED by this run:')
    for (const id of drift.missing) lines.push(`    ${id}`)
  }
  lines.push('')
  lines.push('  The disposition block is therefore not a description of this harness. Fix the')
  lines.push('  manifest if the assertion genuinely moved, or fix the assertion if it did not.')
  lines.push('  ' + '!'.repeat(74))
  lines.push('')
  return lines.join('\n')
}
