/**
 * SUITE 5 — magic-link request failure modes. A REGRESSION SUITE, NOT A FIFTH ATTACK.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS IS DELIBERATELY NOT "ATTACK 5"
 * ------------------------------------------------------------------------------------
 * `docs/VERIFICATION.md` is structured around the four attacks the brief requires, and that
 * framing is load-bearing — "the four attacks" has to keep meaning the same four. This suite
 * is printed after them and counted separately, the same way `check:secrets` is explicitly not
 * one of the four.
 *
 * ------------------------------------------------------------------------------------
 * THE DEFECT IT EXISTS TO CATCH
 * ------------------------------------------------------------------------------------
 * `requestMagicLink()` used to log every error class and redirect to /login/check-email
 * regardless. A wrong or rotated anon key, or a Supabase incident, showed all ~120 reps
 * "check your email" while no email was sent and the portal looked healthy.
 *
 *   5.1  the classification predicate, every branch, executing the PRODUCT'S REAL CODE
 *   5.2  the real hosted error shape for an invalid key — turns an inference into a measurement
 *   5.3  the error page actually renders, and the pre-existing ?invalid=1 branch still does
 *   5.4  REQUIRED ASSERTION 2 — an unregistered address still gets the identical success page
 *   5.5  REQUIRED ASSERTION 1 — an invalid anon key surfaces a user-visible error (opt-in)
 *
 * ------------------------------------------------------------------------------------
 * 5.1 RUNS THE PRODUCT'S CODE. IT DOES NOT MIRROR IT.
 * ------------------------------------------------------------------------------------
 * `app/login/auth-error.ts` imports nothing, so `tsc` compiles it standalone into
 * `verify/.out` with CLI flags and this file imports the compiled artefact. A mirrored
 * predicate would keep passing its own tests forever while the application diverged from it.
 * `tsconfig.json` is not touched and is not used: passing files on the command line makes tsc
 * ignore it. If the compile fails, every 5.1 and 5.2 assertion reports NOT EXECUTED with the
 * compiler output as the reason — never PASS, never FAIL.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { Report } from '../lib/report.mjs'
import { MANIFEST } from '../lib/manifest.mjs'
import { REPO } from './lib/config.mjs'
import { NOT_EXECUTED_NO_BASE_URL, NOT_EXECUTED_COOKIE_REJECTED } from './lib/app-probe.mjs'

export const SUITE_NUMBER = 5
export const SUITE_TITLE = 'Magic-link request failure modes (regression suite)'

const METHOD = `the product's own classifyAuthError is compiled standalone and executed over the
table in verify/login/predicate-cases.ts; the real gateway is probed with a
deliberately invalid apikey to measure the shape that inference rests on; the
rendered /login page is fetched for each branch; and the registered and
unregistered responses are compared byte for byte through the no-JS Server
Action form encoding. Nothing here sends or reads email.`

/**
 * Not a credential and not key-shaped. It grants nothing, unlocks nothing, and is checked in
 * on purpose so the failure path is reproducible without anyone being asked for a real key.
 */
export const DELIBERATELY_INVALID_KEY = 'not-a-valid-key-deliberately-invalid-for-verification'

export const NOT_EXECUTED_OPT_IN =
  'NOT EXECUTED — opt-in: requires booting a second application instance with a deliberately ' +
  'invalid anon key. Run `npm run verify:login-failure`.'

const OUT_DIR = join(REPO, 'verify', '.out')

/** A short, unique-per-run token so two runs never collide on an address or a probe. */
export function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ==================================================================== *
 * Compiling the product's predicate
 * ==================================================================== */

/**
 * Compiles `app/login/auth-error.ts` + `verify/login/predicate-cases.ts` into `verify/.out`
 * and imports both.
 *
 * `verify/.out` is gitignored (`.gitignore:16`). The generated `package.json` in it marks the
 * output as ESM: this repository has no top-level `"type": "module"`, so without it Node would
 * read the emitted `.js` as CommonJS and the `export` statements would throw. It is generated,
 * never committed, and nothing outside `verify/.out` is written.
 */
export async function compilePredicate() {
  const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')
  const args = [
    tsc,
    'app/login/auth-error.ts',
    'verify/login/predicate-cases.ts',
    '--outDir',
    'verify/.out',
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--strict',
  ]

  const proc = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' })
  if (proc.status !== 0) {
    const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim()
    return {
      ok: false,
      reason:
        'NOT EXECUTED — the predicate could not be compiled. tsc exited ' +
        `${proc.status ?? 'without a status'}: ${out || '(no compiler output)'}`,
    }
  }

  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'package.json'), '{ "type": "module" }\n')
    const predicate = await import(
      pathToFileURL(join(OUT_DIR, 'app', 'login', 'auth-error.js')).href
    )
    const cases = await import(
      pathToFileURL(join(OUT_DIR, 'verify', 'login', 'predicate-cases.js')).href
    )
    return {
      ok: true,
      classifyAuthError: predicate.classifyAuthError,
      LOGIN_ERROR: predicate.LOGIN_ERROR,
      // The REAL runtime sets, not a grep of the source text. 5.C asserts the 5.1 table against
      // the same objects classifyAuthError branches on, which is the same property that makes
      // 5.1 an execution of the product's code rather than a mirror of it.
      SUPPRESSED_CODES: predicate.SUPPRESSED_CODES,
      RATE_LIMIT_CODES: predicate.RATE_LIMIT_CODES,
      cases: cases.PREDICATE_CASES,
    }
  } catch (err) {
    return {
      ok: false,
      reason:
        'NOT EXECUTED — the predicate compiled but could not be imported: ' +
        `${err?.message ?? String(err)}`,
    }
  }
}

/* ==================================================================== *
 * 5.1 — the predicate table
 * ==================================================================== */

export function runPredicateTable(report, compiled) {
  if (!compiled.ok) {
    // The ids still have to appear, or the disposition drifts. One per declared case is
    // impossible without the table, so the whole block is reported under 5.1.
    for (const id of PREDICATE_IDS) {
      report.notExecuted(id, 'classifyAuthError decides this input shape', compiled.reason)
    }
    return
  }

  for (const c of compiled.cases) {
    const observed = compiled.classifyAuthError(c.input)
    report.check(
      c.id,
      c.description,
      observed?.klass === c.expected,
      `expected ${c.expected}, observed ${JSON.stringify(observed)} for input ` +
        `${JSON.stringify(c.input)}`,
    )
  }
}

/**
 * The declared 5.1 id space, taken from the manifest so that a compile failure still emits
 * every id and the disposition does not drift. Growing verify/login/predicate-cases.ts without
 * growing the manifest is caught by checkDrift in the other direction, so there is exactly one
 * place to edit and one mechanism watching it.
 */
const PREDICATE_IDS = MANIFEST.filter((e) => e.id.startsWith('5.1.')).map((e) => e.id)

/* ==================================================================== *
 * 5.C — invariants BETWEEN the 5.1 table and the predicate's own sets
 * ==================================================================== */

/**
 * 5.1 asks "does the predicate decide this input correctly". 5.C asks the question 5.1 cannot:
 * "is the table still asking about the right inputs".
 *
 * The failure these exist to catch is a SILENT one. Add a code to SUPPRESSED_CODES and forget
 * the matching row, and every 5.1 row still passes — the table simply never mentions the new
 * code, and the branch that shows a success page grows without a single assertion noticing.
 * Delete a code from SUPPRESSED_CODES and the corresponding row starts failing, which is loud;
 * ADDING one is the direction with no alarm on it. 5.C1/5.C2 close that direction. 5.C3/5.C5
 * close the reverse — a row asserting SUPPRESSED for a code the product does not suppress
 * would be a table that has stopped describing the product.
 *
 * These are STATIC, not live: they assert the SHAPE of a source table against the predicate's
 * own runtime sets. Nothing is executed against a deployed target, so nothing here may ever be
 * counted as a live pass. That is exactly what `report.staticCheck` encodes.
 *
 * They read the REAL exported Sets out of the compiled artefact rather than grepping
 * `auth-error.ts` for strings — the same reason 5.1 executes the product's code instead of
 * mirroring it. A grep would keep agreeing with a comment long after the code moved on.
 */
export const PREDICATE_INVARIANT_IDS = ['5.C1', '5.C2', '5.C3', '5.C4', '5.C5']

export const PREDICATE_INVARIANT_DESCRIPTIONS = {
  '5.C1': 'every SUPPRESSED_CODES member has a 5.1 row expecting SUPPRESSED',
  '5.C2': 'every RATE_LIMIT_CODES member has a 5.1 row expecting RATE_LIMITED',
  '5.C3': 'no 5.1 row expects SUPPRESSED for a code outside SUPPRESSED_CODES',
  '5.C4': '5.1.13 and 5.1.16 survive, expect UNAVAILABLE, and 5.1.16 uses a code in neither set',
  '5.C5': 'no 5.1 row expects RATE_LIMITED for a code outside RATE_LIMIT_CODES',
}

const INVARIANT_NOTE =
  'STATIC — asserts the SHAPE of verify/login/predicate-cases.ts against the predicate\'s own ' +
  'exported code sets. Real, but it asserts SOURCE, not deployed state, and is never a live pass.'

export function runPredicateTableInvariants(report, compiled) {
  const notExecutedAllInvariants = (reason) => {
    for (const id of PREDICATE_INVARIANT_IDS) {
      report.notExecuted(id, PREDICATE_INVARIANT_DESCRIPTIONS[id], reason)
    }
  }

  if (!compiled.ok) {
    // Same pattern as runPredicateTable: the ids still have to appear, or the disposition
    // drifts. A compile failure is NOT EXECUTED — never PASS, never FAIL.
    notExecutedAllInvariants(compiled.reason)
    return
  }

  // A missing set would make 5.C1/5.C2 pass VACUOUSLY, which is the exact failure mode this
  // whole suite exists to refuse. An absent set is an absence of evidence, so it is reported
  // as one rather than as agreement.
  const isSet = (v) => v instanceof Set || (v && typeof v.has === 'function' && typeof v[Symbol.iterator] === 'function')
  if (!isSet(compiled.SUPPRESSED_CODES) || !isSet(compiled.RATE_LIMIT_CODES)) {
    notExecutedAllInvariants(
      'NOT EXECUTED — the compiled app/login/auth-error.ts did not export SUPPRESSED_CODES and ' +
        'RATE_LIMIT_CODES as iterable sets, so the table could not be compared against the real ' +
        'runtime sets. Asserting against nothing would pass vacuously; it is reported as not run.',
    )
    return
  }
  if (!Array.isArray(compiled.cases)) {
    notExecutedAllInvariants(
      'NOT EXECUTED — verify/login/predicate-cases.ts did not export PREDICATE_CASES as an array.',
    )
    return
  }

  const cases = compiled.cases
  const suppressed = [...compiled.SUPPRESSED_CODES]
  const rateLimited = [...compiled.RATE_LIMIT_CODES]
  const codeOf = (c) => (typeof c?.input?.code === 'string' ? c.input.code : undefined)
  const hasRow = (code, expected) =>
    cases.some((c) => codeOf(c) === code && c.expected === expected)
  const rowById = (id) => cases.find((c) => c.id === id)

  const unrepresentedSuppressed = suppressed.filter((code) => !hasRow(code, 'SUPPRESSED'))
  report.staticCheck(
    '5.C1',
    PREDICATE_INVARIANT_DESCRIPTIONS['5.C1'],
    unrepresentedSuppressed.length === 0,
    INVARIANT_NOTE,
    `SUPPRESSED_CODES members with no 5.1 row carrying that input.code AND expected 'SUPPRESSED': ` +
      `${JSON.stringify(unrepresentedSuppressed)}. A suppressed code with no row is a widening of ` +
      `the branch that shows a success page, asserted by nothing.`,
  )

  const unrepresentedRateLimited = rateLimited.filter((code) => !hasRow(code, 'RATE_LIMITED'))
  report.staticCheck(
    '5.C2',
    PREDICATE_INVARIANT_DESCRIPTIONS['5.C2'],
    unrepresentedRateLimited.length === 0,
    INVARIANT_NOTE,
    `RATE_LIMIT_CODES members with no 5.1 row carrying that input.code AND expected ` +
      `'RATE_LIMITED': ${JSON.stringify(unrepresentedRateLimited)}.`,
  )

  const strayS = cases
    .filter((c) => c.expected === 'SUPPRESSED')
    .filter((c) => {
      const code = codeOf(c)
      return code === undefined || !compiled.SUPPRESSED_CODES.has(code)
    })
    .map((c) => ({ id: c.id, code: codeOf(c) }))
  report.staticCheck(
    '5.C3',
    PREDICATE_INVARIANT_DESCRIPTIONS['5.C3'],
    strayS.length === 0,
    INVARIANT_NOTE,
    `rows expecting SUPPRESSED for a code the product does not suppress: ${JSON.stringify(strayS)}. ` +
      `The table has stopped describing the product.`,
  )

  const gap = rowById('5.1.13')
  const forward = rowById('5.1.16')
  const forwardCode = forward ? codeOf(forward) : undefined
  const c4 =
    gap !== undefined &&
    forward !== undefined &&
    gap.expected === 'UNAVAILABLE' &&
    forward.expected === 'UNAVAILABLE' &&
    forwardCode !== undefined &&
    !compiled.SUPPRESSED_CODES.has(forwardCode) &&
    !compiled.RATE_LIMIT_CODES.has(forwardCode)
  report.staticCheck(
    '5.C4',
    PREDICATE_INVARIANT_DESCRIPTIONS['5.C4'],
    c4,
    INVARIANT_NOTE,
    `5.1.13 = ${JSON.stringify(gap ? { expected: gap.expected } : null)}, 5.1.16 = ` +
      `${JSON.stringify(forward ? { expected: forward.expected, code: forwardCode } : null)}. ` +
      `Together these two state the property the whole fix rests on: an error nobody has seen is ` +
      `never reported to the user as a success. 5.1.16 only states it while its code is genuinely ` +
      `unrecognised by BOTH sets — the moment that code is added to one, the row stops testing ` +
      `forward-compatibility and starts testing the branch it was meant to bypass.`,
  )

  const strayR = cases
    .filter((c) => c.expected === 'RATE_LIMITED')
    .filter((c) => {
      const code = codeOf(c)
      // A row with NO code that expects RATE_LIMITED is legitimate — it exercises the
      // status === 429 branch, which is decided without any code at all (5.1.9).
      return code !== undefined && !compiled.RATE_LIMIT_CODES.has(code)
    })
    .map((c) => ({ id: c.id, code: codeOf(c) }))
  report.staticCheck(
    '5.C5',
    PREDICATE_INVARIANT_DESCRIPTIONS['5.C5'],
    strayR.length === 0,
    INVARIANT_NOTE,
    `rows expecting RATE_LIMITED for a code outside RATE_LIMIT_CODES: ${JSON.stringify(strayR)}.`,
  )
}

/* ==================================================================== *
 * 5.2 — the real hosted error shape
 * ==================================================================== */

/**
 * Calls the REAL GoTrue endpoint with a deliberately invalid apikey and records what comes
 * back. This is what turns "401 means the anon key is bad" from an inference about endpoint
 * semantics into a measurement, on every hosted run. If Supabase ever answers something other
 * than an UNAVAILABLE-classified shape, 5.2b fails loudly instead of the portal failing
 * silently.
 *
 * Nothing derived from process.env is printed. The address is non-routable.
 */
export async function probeHostedErrorShape(report, cfg, compiled, runId) {
  if (!compiled.ok) {
    for (const id of ['5.2a', '5.2b', '5.2c']) {
      report.notExecuted(id, 'the real gateway error shape for an invalid anon key', compiled.reason)
    }
    return
  }

  let error = null
  let thrown = null
  try {
    const client = createClient(cfg.url, DELIBERATELY_INVALID_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const res = await client.auth.signInWithOtp({
      email: `probe-${runId}@example.invalid`,
      options: { shouldCreateUser: false },
    })
    error = res.error ?? null
  } catch (err) {
    thrown = err
  }

  report.check(
    '5.2a',
    'an invalid anon key produces an error object, not a silent success',
    thrown === null && error !== null,
    thrown
      ? `signInWithOtp threw instead of returning an error: ${thrown?.message ?? String(thrown)}`
      : 'signInWithOtp returned no error at all — a deliberately invalid key was accepted',
  )

  const observed = compiled.classifyAuthError(error)
  report.check(
    '5.2b',
    'the real invalid-key error classifies as UNAVAILABLE',
    observed?.klass === 'UNAVAILABLE',
    `observed ${JSON.stringify(observed)} for status=${JSON.stringify(error?.status)} ` +
      `code=${JSON.stringify(error?.code)}`,
  )

  const shape = `status=${JSON.stringify(error?.status)} code=${JSON.stringify(error?.code)} ` +
    `name=${JSON.stringify(error?.name)}`
  report.check(
    '5.2c',
    'the observed status and code are recorded verbatim in the run notes',
    error !== null,
    'there was no error object to record',
  )
  report.notes.push(
    `5.2c: the hosted gateway answered a deliberately invalid apikey with ${shape}, ` +
      `classified ${observed?.klass} (${observed?.reason}). This is the measurement behind the ` +
      `401 inference recorded in app/login/auth-error.ts — read it before trusting that branch.`,
  )
}

/* ==================================================================== *
 * 5.3 — the error page renders
 * ==================================================================== */

const RENDER_CASES = [
  {
    id: '5.3a',
    path: '/login?error=unavailable',
    description: 'GET /login?error=unavailable renders the Cannot send notice',
    must: ['Cannot send'],
    mustNot: ['Check your email'],
  },
  {
    id: '5.3b',
    path: '/login?error=rate_limited',
    description: 'GET /login?error=rate_limited renders the Too many requests notice',
    must: ['Too many requests'],
    mustNot: [],
  },
  {
    id: '5.3c',
    path: '/login?invalid=1',
    description: 'GET /login?invalid=1 still renders the pre-existing validation notice',
    must: ['Enter a valid email address.'],
    mustNot: [],
  },
  {
    id: '5.3d',
    path: '/login',
    description: 'GET /login renders neither error label',
    must: [],
    mustNot: ['Cannot send', 'Too many requests'],
  },
]

export async function runRenderChecks(report, baseUrl) {
  if (!baseUrl) {
    for (const c of RENDER_CASES) report.notExecuted(c.id, c.description, NOT_EXECUTED_NO_BASE_URL)
    return
  }

  for (const c of RENDER_CASES) {
    let res
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, '')}${c.path}`, { redirect: 'manual' })
    } catch (err) {
      report.notExecuted(
        c.id,
        c.description,
        `NOT EXECUTED — the app at PORTAL_BASE_URL was unreachable: ${err?.message ?? String(err)}`,
      )
      continue
    }
    const body = await res.text()
    const missing = c.must.filter((s) => !body.includes(s))
    const present = c.mustNot.filter((s) => body.includes(s))
    report.check(
      c.id,
      c.description,
      res.status === 200 && missing.length === 0 && present.length === 0,
      `HTTP ${res.status}; missing ${JSON.stringify(missing)}; unexpectedly present ` +
        `${JSON.stringify(present)}`,
    )
  }
}

/* ==================================================================== *
 * The no-JS Server Action form encoding
 * ==================================================================== */

/**
 * ------------------------------------------------------------------------------------
 * A KNOWN-BRITTLE DEPENDENCY ON A FRAMEWORK INTERNAL. PINNED: next 15.5.23.
 * ------------------------------------------------------------------------------------
 * `<form action={requestMagicLink}>` renders, for a client without JavaScript, as a plain
 * `method="POST"` form carrying a hidden input whose NAME is `$ACTION_ID_<id>`. Posting that
 * field is how this harness drives a Server Action over plain HTTP without a browser.
 *
 * MEASURED, NOT ASSUMED: next 15.5.23 renders that form with
 * `encType="multipart/form-data"`, and the server action handler only recognises the no-JS
 * submission when the request body IS multipart. The same POST sent as
 * `application/x-www-form-urlencoded` is not treated as an action at all — the page simply
 * re-renders with HTTP 200 and no Location header, which looks exactly like a broken
 * assertion. So the encoding is read off the rendered form rather than hardcoded, and the
 * submission follows whatever the page says it uses.
 *
 * All of this is a Next.js implementation detail and may change without notice. It is
 * isolated to these two functions on purpose. If the field cannot be located, EVERY assertion
 * that depends on it reports NOT EXECUTED with that reason — it is never a FAIL, because a
 * framework rename is not a defect in this application.
 */
export function findActionId(html) {
  const idMatch = html.match(/name="(\$ACTION_ID_[^"]+)"/)
  if (idMatch) {
    const form = html.match(/<form\b[^>]*>/i)
    const enc = form ? form[0].match(/enctype="([^"]+)"/i) : null
    return { ok: true, field: idMatch[1], encType: enc ? enc[1] : 'multipart/form-data' }
  }

  const refMatch = html.match(/name="(\$ACTION_REF_[^"]+)"/)
  return {
    ok: false,
    field: null,
    encType: null,
    reason:
      'NOT EXECUTED — the Next.js no-JS Server Action encoding could not be located in /login ' +
      `(pinned: next 15.5.23)${refMatch ? `; the page carried ${refMatch[1]} instead, which is a ` +
      'different encoding and is not driven by this harness' : ''}`,
  }
}

/** GETs /login and extracts the action field. */
export async function locateLoginAction(baseUrl) {
  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/login`, { redirect: 'manual' })
  } catch (err) {
    return {
      ok: false,
      reason: `NOT EXECUTED — the app at ${baseUrl} was unreachable: ${err?.message ?? String(err)}`,
    }
  }
  if (res.status !== 200) {
    return { ok: false, reason: `NOT EXECUTED — GET /login answered HTTP ${res.status}` }
  }
  return findActionId(await res.text())
}

/**
 * Submits the login form the way a browser without JavaScript would, in the encoding the
 * rendered form declares. `redirect: 'manual'` is load-bearing: the Location header IS the
 * assertion, and following the redirect would replace it with whatever /login answers.
 */
export async function submitLoginForm(baseUrl, field, email, encType = 'multipart/form-data') {
  const urlencoded = String(encType).toLowerCase().includes('urlencoded')

  let body
  let headers
  if (urlencoded) {
    const params = new URLSearchParams()
    params.set(field, '')
    params.set('email', email)
    body = params.toString()
    headers = { 'content-type': 'application/x-www-form-urlencoded' }
  } else {
    // fetch sets content-type: multipart/form-data with the boundary for a FormData body.
    const form = new FormData()
    form.set(field, '')
    form.set('email', email)
    body = form
    headers = undefined
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/login`, {
      method: 'POST',
      redirect: 'manual',
      ...(headers ? { headers } : {}),
      body,
    })
    return { ok: true, status: res.status, location: res.headers.get('location'), error: null }
  } catch (err) {
    return { ok: false, status: 0, location: null, error: err?.message ?? String(err) }
  }
}

/** Splits a Location header into path and query, resolved against the base. */
export function locationParts(location, baseUrl) {
  if (!location) return { path: null, search: null }
  try {
    const u = new URL(location, baseUrl ?? 'http://placeholder.invalid')
    return { path: u.pathname, search: u.search }
  } catch {
    return { path: null, search: null }
  }
}

/** True when a Location is the rate-limit redirect — 5.4's one legitimate re-run condition. */
export function isRateLimitRedirect(location, baseUrl) {
  const { search } = locationParts(location, baseUrl)
  return typeof search === 'string' && search.includes('error=rate_limited')
}

/* ==================================================================== *
 * 5.4 — REQUIRED ASSERTION 2: the two responses are indistinguishable
 * ==================================================================== */

const EQUIVALENCE_IDS = ['5.4a', '5.4b', '5.4c', '5.4d']
const EQUIVALENCE_DESCRIPTIONS = {
  '5.4a': 'an UNREGISTERED address is answered with /login/check-email',
  '5.4b': 'a REGISTERED address is answered with /login/check-email',
  '5.4c': 'the two Location values are byte-identical and carry no query string',
  '5.4d': 'the two responses carry identical status codes',
}

const notExecutedAll = (report, ids, descriptions, reason) => {
  for (const id of ids) report.notExecuted(id, descriptions[id], reason)
}

/**
 * ------------------------------------------------------------------------------------
 * 5.4 IS SPLIT IN THREE ON PURPOSE. THE SPLIT IS THE ASSERTION.
 * ------------------------------------------------------------------------------------
 * NOT EXECUTED and FAIL mean opposite things — "we have no evidence" versus "we have evidence
 * and it differed" — and the Human's ruling on the UNAVAILABLE default in
 * `app/login/auth-error.ts` rests on 5.4 being able to say the second one. So the two states
 * are separated STRUCTURALLY rather than by care:
 *
 *   resolveEquivalenceInputs   every precondition, and the ONLY place NOT EXECUTED is reachable.
 *                              It takes no `report`, so it cannot emit a PASS or a FAIL either.
 *   assertEquivalence          the comparison. It is handed a verdict-only facade, so once both
 *                              responses are in hand it cannot reach notExecuted() — the call
 *                              throws. All four ids are emitted unconditionally, no early return.
 *   runEnumerationEquivalence  the seam between them, and nothing else.
 *
 * Behaviour is identical to the single function this replaced: same ids, same statuses, same
 * reasons, same exit codes on every input. What changed is that the harness can no longer
 * silently degrade a real difference between the two responses into "did not run".
 */

/**
 * Every precondition for 5.4, and nowhere else. Returns `{ ready: false, reason }` when the
 * comparison genuinely cannot be attempted, or `{ ready: true, unregistered, registered }`.
 * It is handed no `report`, which is what makes the "no verdict from here" property structural.
 */
export async function resolveEquivalenceInputs(baseUrl, runId) {
  if (!baseUrl) {
    return { ready: false, reason: NOT_EXECUTED_NO_BASE_URL }
  }

  const located = await locateLoginAction(baseUrl)
  if (!located.ok) {
    return { ready: false, reason: located.reason }
  }

  const unregistered = await submitLoginForm(
    baseUrl,
    located.field,
    `unregistered-${runId}@example.invalid`,
    located.encType,
  )
  const registered = await submitLoginForm(
    baseUrl,
    located.field,
    'rep.verify@example.invalid',
    located.encType,
  )

  if (!unregistered.ok || !registered.ok) {
    return {
      ready: false,
      reason:
        `NOT EXECUTED — the form POST to ${baseUrl}/login failed: ` +
        `${unregistered.error ?? registered.error}`,
    }
  }

  // 5.4b sends a real magic link to a non-routable address and consumes that address's
  // throttle, so back-to-back runs can legitimately hit the per-address rate limit. That is
  // a re-run condition, not a failure of the system under test.
  if (
    isRateLimitRedirect(unregistered.location, baseUrl) ||
    isRateLimitRedirect(registered.location, baseUrl)
  ) {
    return {
      ready: false,
      reason:
        'NOT EXECUTED — the per-address email throttle fired; re-run after the throttle window',
    }
  }

  return { ready: true, unregistered, registered }
}

/**
 * A Report view that can ONLY record a verdict. Handed to assertEquivalence so that once both
 * responses are in hand the comparison physically cannot reach notExecuted(). The two states
 * mean opposite things — "we have no evidence" versus "we have evidence and it differed" — and
 * the Human's ruling on the UNAVAILABLE default rests on 5.4 being able to say the second one.
 */
function verdictOnly(report) {
  return {
    check: (id, description, condition, detail) => report.check(id, description, condition, detail),
    notExecuted(id) {
      throw new Error(
        `5.4: the equivalence comparison reached notExecuted() for ${id}. Both responses were ` +
          `already in hand, so the only honest outcomes are PASS and FAIL. Every NOT EXECUTED ` +
          `path for 5.4 belongs in resolveEquivalenceInputs(), strictly before the comparison.`,
      )
    },
  }
}

/**
 * The comparison itself. `verdict` is the facade, NOT the Report — that is the guard. There is
 * no early return: all four ids are emitted unconditionally, every time this is reached.
 */
export function assertEquivalence(verdict, unregistered, registered, baseUrl) {
  const u = locationParts(unregistered.location, baseUrl)
  const r = locationParts(registered.location, baseUrl)

  verdict.check(
    '5.4a',
    EQUIVALENCE_DESCRIPTIONS['5.4a'],
    u.path === '/login/check-email',
    `observed HTTP ${unregistered.status} -> ${unregistered.location}`,
  )
  verdict.check(
    '5.4b',
    EQUIVALENCE_DESCRIPTIONS['5.4b'],
    r.path === '/login/check-email',
    `observed HTTP ${registered.status} -> ${registered.location}`,
  )
  // THE assertion. Not "both look like success" but "the two responses are indistinguishable".
  verdict.check(
    '5.4c',
    EQUIVALENCE_DESCRIPTIONS['5.4c'],
    unregistered.location !== null &&
      unregistered.location === registered.location &&
      u.search === '' &&
      r.search === '',
    `unregistered ${JSON.stringify(unregistered.location)} vs registered ` +
      `${JSON.stringify(registered.location)}`,
  )
  verdict.check(
    '5.4d',
    EQUIVALENCE_DESCRIPTIONS['5.4d'],
    unregistered.status === registered.status,
    `unregistered HTTP ${unregistered.status} vs registered HTTP ${registered.status}`,
  )
}

/** The seam. Preconditions, or comparison. Nothing else lives here. */
export async function runEnumerationEquivalence(report, baseUrl, runId) {
  const inputs = await resolveEquivalenceInputs(baseUrl, runId)
  if (!inputs.ready) {
    notExecutedAll(report, EQUIVALENCE_IDS, EQUIVALENCE_DESCRIPTIONS, inputs.reason)
    return
  }
  assertEquivalence(verdictOnly(report), inputs.unregistered, inputs.registered, baseUrl)
}

/* ==================================================================== *
 * 5.5 — REQUIRED ASSERTION 1: an invalid anon key surfaces an error
 * ==================================================================== */

export const INVALID_KEY_IDS = ['5.5a', '5.5b']
export const INVALID_KEY_DESCRIPTIONS = {
  '5.5a': 'an invalid anon key redirects to /login?error=unavailable, NOT to /login/check-email',
  '5.5b': "the server-side log line survives the fix ('[login] signInWithOtp failed: unavailable:')",
}

/**
 * The 5.5 assertions, driven against an ALREADY-RUNNING instance that was booted with a
 * deliberately invalid anon key. `verify/login-failure.mjs` owns the booting; this owns the
 * assertions, so the default run and the opt-in run make the same claim from the same code.
 *
 * DELIBERATELY NOT GIVEN 5.4's verdictOnly GUARD, and that asymmetry is not an oversight: 5.5
 * is opt-in rather than default-run, so its NOT EXECUTED is the normal outcome of `npm run
 * verify` rather than a degradation to be structurally prevented.
 */
export async function runInvalidKeyProbe(report, baseUrl, runId, readStderr) {
  const located = await locateLoginAction(baseUrl)
  if (!located.ok) {
    notExecutedAll(report, INVALID_KEY_IDS, INVALID_KEY_DESCRIPTIONS, located.reason)
    return
  }

  const submitted = await submitLoginForm(
    baseUrl,
    located.field,
    `probe-${runId}@example.invalid`,
    located.encType,
  )
  if (!submitted.ok) {
    notExecutedAll(
      report,
      INVALID_KEY_IDS,
      INVALID_KEY_DESCRIPTIONS,
      `NOT EXECUTED — the form POST failed: ${submitted.error}`,
    )
    return
  }

  const { path, search } = locationParts(submitted.location, baseUrl)
  const expected = '/login?error=unavailable'
  const observedPathAndQuery = path === null ? String(submitted.location) : `${path}${search}`

  // Asserted as the EXACT expected value. "Anything other than check-email" would pass on a
  // 500, on a framework error page, and on any future wrong-but-different redirect.
  report.check(
    '5.5a',
    INVALID_KEY_DESCRIPTIONS['5.5a'],
    observedPathAndQuery === expected,
    `expected ${expected}; observed HTTP ${submitted.status} -> ` +
      `${JSON.stringify(submitted.location)}` +
      (path === '/login/check-email'
        ? ' — THIS IS THE DEFECT: a failed send was reported to the user as a sent email'
        : ''),
  )

  const stderr = typeof readStderr === 'function' ? readStderr() : ''
  report.check(
    '5.5b',
    INVALID_KEY_DESCRIPTIONS['5.5b'],
    /\[login\] signInWithOtp failed: unavailable:/.test(stderr),
    'the child process stderr carried no matching line. Last 400 characters: ' +
      JSON.stringify(String(stderr).slice(-400)),
  )
}

/* ==================================================================== *
 * 5.6 — THE CONFIGURATION HEALTH SIGNAL
 * ==================================================================== */

/**
 * ------------------------------------------------------------------------------------
 * WHAT THESE ASSERT, AND WHY 5.6b AND 5.6e ARE THE IMPORTANT ONES
 * ------------------------------------------------------------------------------------
 * `GET /api/health/auth` is the cost of the 2026-08-19 ruling, paid rather than absorbed: with
 * `otp_disabled` and `over_email_send_rate_limit` classified SUPPRESSED, a project in which
 * nobody can sign in looks healthy to every rep. This endpoint reports that from the server.
 *
 * It is UNAUTHENTICATED by construction (an authenticated health check is useless in the exact
 * failure it detects), so the assertions that matter most are the anti-leak ones:
 *
 *   5.6b  the body carries EXACTLY the five declared keys. ANY EXTRA KEY FAILS. A health
 *         endpoint grows a `detail` or `message` field the moment someone is debugging, and
 *         free text is how a key, an address or a vendor message gets out of one.
 *   5.6e  the RAW response text contains no '@' and nothing JWT-shaped.
 *
 * 5.6d states the one-sidedness as an assertion rather than as a comment: `otpEnabled` can
 * prove "no" and can never prove "yes".
 */
export const HEALTH_SIGNAL_IDS = ['5.6a', '5.6b', '5.6c', '5.6d', '5.6e', '5.6f', '5.6g', '5.6h']
export const HEALTH_SIGNAL_DESCRIPTIONS = {
  '5.6a': 'GET /api/health/auth answers 200 with a JSON content-type',
  '5.6b': 'the body carries EXACTLY the five declared keys and no others',
  '5.6c': 'every value is inside its declared closed set',
  '5.6d': 'otpEnabled is never "yes" (the probe is one-sided by construction)',
  '5.6e': 'the response carries no key material and no address',
  '5.6f': 'POST /api/health/auth is refused with 405 and Allow: GET',
  '5.6g': 'the otp_disabled measurement is recorded verbatim in the run notes',
  '5.6h': 'the rate limiter fires',
}

const DECLARED_HEALTH_KEYS = [
  'anonKeyAccepted',
  'authEndpointReachable',
  'checkedAt',
  'otpEnabled',
  'verdict',
]
const TRI = new Set(['yes', 'no', 'unknown'])
const VERDICTS = new Set(['broken', 'no_fault_detected', 'unmeasured'])

export async function runHealthSignalChecks(report, baseUrl) {
  if (!baseUrl) {
    notExecutedAll(report, HEALTH_SIGNAL_IDS, HEALTH_SIGNAL_DESCRIPTIONS, NOT_EXECUTED_NO_BASE_URL)
    return
  }

  const base = baseUrl.replace(/\/+$/, '')

  let res
  let raw
  try {
    res = await fetch(`${base}/api/health/auth`, { redirect: 'manual' })
    raw = await res.text()
  } catch (err) {
    notExecutedAll(
      report,
      HEALTH_SIGNAL_IDS,
      HEALTH_SIGNAL_DESCRIPTIONS,
      `NOT EXECUTED — the app at PORTAL_BASE_URL was unreachable: ${err?.message ?? String(err)}`,
    )
    return
  }

  const contentType = res.headers.get('content-type') ?? ''
  report.check(
    '5.6a',
    HEALTH_SIGNAL_DESCRIPTIONS['5.6a'],
    res.status === 200 && contentType.includes('application/json'),
    `HTTP ${res.status}, content-type ${JSON.stringify(contentType)}`,
  )

  let parsed = null
  let parseError = null
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    parseError = err?.message ?? String(err)
  }

  if (parsed === null || typeof parsed !== 'object') {
    const reason =
      'NOT EXECUTED — the response body was not a JSON object' +
      `${parseError ? `: ${parseError}` : ''}. There was nothing to inspect.`
    for (const id of ['5.6b', '5.6c', '5.6d']) {
      report.notExecuted(id, HEALTH_SIGNAL_DESCRIPTIONS[id], reason)
    }
  } else {
    const keys = Object.keys(parsed).sort()
    report.check(
      '5.6b',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6b'],
      keys.length === DECLARED_HEALTH_KEYS.length &&
        keys.every((k, i) => k === DECLARED_HEALTH_KEYS[i]),
      `expected ${JSON.stringify(DECLARED_HEALTH_KEYS)}, observed ${JSON.stringify(keys)}. ` +
        `An EXTRA KEY IS A FAILURE, not a nicety: this endpoint is unauthenticated and its ` +
        `safety rests on having no free-text field for a key, an address or a vendor message ` +
        `to leak through.`,
    )

    const checkedAtOk =
      typeof parsed.checkedAt === 'string' && !Number.isNaN(Date.parse(parsed.checkedAt))
    report.check(
      '5.6c',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6c'],
      TRI.has(parsed.authEndpointReachable) &&
        TRI.has(parsed.anonKeyAccepted) &&
        TRI.has(parsed.otpEnabled) &&
        VERDICTS.has(parsed.verdict) &&
        checkedAtOk,
      `authEndpointReachable=${JSON.stringify(parsed.authEndpointReachable)} ` +
        `anonKeyAccepted=${JSON.stringify(parsed.anonKeyAccepted)} ` +
        `otpEnabled=${JSON.stringify(parsed.otpEnabled)} ` +
        `verdict=${JSON.stringify(parsed.verdict)} checkedAt parses=${checkedAtOk}`,
    )

    report.check(
      '5.6d',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6d'],
      parsed.otpEnabled !== 'yes',
      `observed otpEnabled=${JSON.stringify(parsed.otpEnabled)}. The probe can prove OTP is ` +
        `DISABLED and can never prove it is enabled; a "yes" would mean someone widened the ` +
        `union without a measurement.`,
    )
  }

  const hasAt = raw.includes('@')
  const hasJwtShape = /eyJ[A-Za-z0-9_-]{10,}/.test(raw)
  report.check(
    '5.6e',
    HEALTH_SIGNAL_DESCRIPTIONS['5.6e'],
    !hasAt && !hasJwtShape,
    `the raw response text contains '@': ${hasAt}; contains a JWT-shaped string: ${hasJwtShape}. ` +
      `The response body is ${raw.length} characters. Neither the probe address nor any key ` +
      `may appear in it.`,
  )

  let postRes = null
  try {
    postRes = await fetch(`${base}/api/health/auth`, { method: 'POST', redirect: 'manual' })
  } catch (err) {
    report.notExecuted(
      '5.6f',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6f'],
      `NOT EXECUTED — the POST could not be issued: ${err?.message ?? String(err)}`,
    )
  }
  if (postRes) {
    const allow = postRes.headers.get('allow')
    report.check(
      '5.6f',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6f'],
      postRes.status === 405 && allow === 'GET',
      `HTTP ${postRes.status}, Allow: ${JSON.stringify(allow)}`,
    )
  }

  /* ---------------------------------------------------------------- *
   * 5.6g — THE MEASUREMENT BEHIND THE otp_disabled CLASSIFICATION.
   * ---------------------------------------------------------------- */
  const observedOtp = parsed && typeof parsed === 'object' ? parsed.otpEnabled : undefined
  const observedVerdict = parsed && typeof parsed === 'object' ? parsed.verdict : undefined
  report.check(
    '5.6g',
    HEALTH_SIGNAL_DESCRIPTIONS['5.6g'],
    observedVerdict !== undefined && observedVerdict !== 'unmeasured',
    `the probe reached no conclusion: verdict=${JSON.stringify(observedVerdict)}. ` +
      `"unmeasured" means the run cannot settle the otp_disabled question either way.`,
  )
  report.notes.push(
    `5.6g: GET /api/health/auth observed otpEnabled=${JSON.stringify(observedOtp)}, ` +
      `verdict=${JSON.stringify(observedVerdict)}. This is the measurement behind the ` +
      `otp_disabled classification in app/login/auth-error.ts. Read it before revisiting that ` +
      `row.`,
  )

  /* ---------------------------------------------------------------- *
   * 5.6h — the limiter. MUST RUN LAST: it deliberately exhausts the
   *        window, so anything after it would be answered 429.
   * ---------------------------------------------------------------- */
  let limited = null
  let retryAfter = null
  try {
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/api/health/auth`, { redirect: 'manual' })
      await r.text()
      if (r.status === 429) {
        limited = r.status
        retryAfter = r.headers.get('retry-after')
        break
      }
    }
  } catch (err) {
    report.notExecuted(
      '5.6h',
      HEALTH_SIGNAL_DESCRIPTIONS['5.6h'],
      `NOT EXECUTED — the app became unreachable during the burst: ${err?.message ?? String(err)}`,
    )
    return
  }
  report.check(
    '5.6h',
    HEALTH_SIGNAL_DESCRIPTIONS['5.6h'],
    limited === 429 && retryAfter !== null,
    `after up to 10 sequential GETs the limiter ${limited === 429 ? 'fired' : 'did not fire'} ` +
      `(status ${JSON.stringify(limited)}, Retry-After ${JSON.stringify(retryAfter)}). ` +
      `THIS EVIDENCES IN-PROCESS BEHAVIOUR ON A SINGLE INSTANCE ONLY. The limiter is a ` +
      `module-level Map; on a multi-instance deployment the effective global limit is ` +
      `(instances x limit) and a cold start resets it. See lib/rate-limit.ts.`,
  )
}

/* ==================================================================== *
 * 5.7 — THE httpOnly MEASUREMENT THAT IS OWED
 * ==================================================================== */

/**
 * ------------------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT IS PAYING OFF
 * ------------------------------------------------------------------------------------
 * `lib/supabase/server.ts` and `lib/supabase/middleware.ts` set `httpOnly: true` on the
 * Supabase auth cookie, overriding @supabase/ssr's documented default of `false`. The security
 * finding that asked for it also asked that it be verified BY EXERCISING SIGN-IN THROUGH THE
 * SSR FLOW rather than by reasoning about it.
 *
 * That exercise is not executable at build stage: local verification runs against bare
 * Postgres with a SQL shim, there is no local GoTrue, and the hosted project is off limits to
 * every stage before this one. So the measurement was SCHEDULED here rather than claimed.
 * These two assertions are it. If they report NOT EXECUTED, the measurement STILL has not been
 * taken and must not be written up as though it had.
 *
 * 5.7a is the safety half: httpOnly must not break the server-side session round-trip. It
 * cannot, in principle — `getAll()` reads the inbound Cookie header and httpOnly governs only
 * JavaScript access in a browser — but "in principle" is what this suite exists to replace.
 * 5.7b is the assertion proper.
 */
export const COOKIE_FLAG_IDS = ['5.7a', '5.7b']
export const COOKIE_FLAG_DESCRIPTIONS = {
  '5.7a': 'the SSR session round-trip still works with httpOnly cookies (rep session is accepted)',
  '5.7b': 'every sb-* Set-Cookie the app emits carries HttpOnly',
}

export async function runCookieFlagChecks(report, baseUrl, app) {
  if (!baseUrl) {
    notExecutedAll(report, COOKIE_FLAG_IDS, COOKIE_FLAG_DESCRIPTIONS, NOT_EXECUTED_NO_BASE_URL)
    return
  }
  if (!app || !app.usable || !app.cookie) {
    notExecutedAll(
      report,
      COOKIE_FLAG_IDS,
      COOKIE_FLAG_DESCRIPTIONS,
      app?.reason ?? NOT_EXECUTED_COOKIE_REJECTED,
    )
    return
  }

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/`, {
      headers: { cookie: app.cookie },
      redirect: 'manual',
    })
  } catch (err) {
    notExecutedAll(
      report,
      COOKIE_FLAG_IDS,
      COOKIE_FLAG_DESCRIPTIONS,
      `NOT EXECUTED — the app at PORTAL_BASE_URL was unreachable: ${err?.message ?? String(err)}`,
    )
    return
  }

  const location = res.headers.get('location')
  const isLoginRedirect = (() => {
    if (res.status < 300 || res.status >= 400 || !location) return false
    try {
      return new URL(location, baseUrl).pathname === '/login'
    } catch {
      return String(location).includes('/login')
    }
  })()

  report.check(
    '5.7a',
    COOKIE_FLAG_DESCRIPTIONS['5.7a'],
    !isLoginRedirect && res.status < 500,
    `GET / with the minted rep session answered HTTP ${res.status}` +
      `${location ? ` -> ${location}` : ''}. A redirect to /login would mean the app stopped ` +
      `accepting its own cookie once httpOnly was set — which is the regression this assertion ` +
      `exists to catch. httpOnly governs JavaScript access in a browser and never the inbound ` +
      `Cookie header a server reads.`,
  )

  // Values are NEVER printed. Only the attribute list after the first `;`.
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const authCookies = setCookies.filter((c) => c.startsWith('sb-'))
  const attrsOf = (c) => {
    const [nameValue, ...attrs] = c.split(';')
    return `${nameValue.split('=')[0]}=<redacted>; ${attrs.map((a) => a.trim()).join('; ')}`
  }
  const missing = authCookies.filter((c) => !/;\s*httponly/i.test(c))

  if (authCookies.length === 0) {
    // No Set-Cookie means no session write happened on this request — usually because the
    // token had not aged into its refresh window. There is nothing to assert ON, and asserting
    // over an empty list would pass vacuously. That is an absence of evidence and is reported
    // as one.
    report.notExecuted(
      '5.7b',
      COOKIE_FLAG_DESCRIPTIONS['5.7b'],
      'NOT EXECUTED — the response carried no sb-* Set-Cookie header, so there was no cookie ' +
        'write to inspect. @supabase/ssr only writes on a token refresh, so a freshly minted ' +
        'session usually produces none. Re-run once the minted session has aged into its ' +
        'refresh window. An empty list would pass vacuously and is reported as not run instead.',
    )
    return
  }

  report.check(
    '5.7b',
    COOKIE_FLAG_DESCRIPTIONS['5.7b'],
    missing.length === 0,
    `observed ${authCookies.length} sb-* Set-Cookie header(s): ` +
      `${JSON.stringify(authCookies.map(attrsOf))}. Missing HttpOnly on: ` +
      `${JSON.stringify(missing.map(attrsOf))}. Cookie VALUES are never printed.`,
  )
}

/* ==================================================================== *
 * The suite, as run by `npm run verify`
 * ==================================================================== */

export default async function suite5(ctx) {
  const { cfg, app } = ctx
  const report = new Report(SUITE_NUMBER, SUITE_TITLE, METHOD)
  const runId = newRunId()

  const compiled = await compilePredicate()
  runPredicateTable(report, compiled)
  runPredicateTableInvariants(report, compiled)

  await probeHostedErrorShape(report, cfg, compiled, runId)
  await runRenderChecks(report, cfg.portalBaseUrl)
  await runEnumerationEquivalence(report, cfg.portalBaseUrl, runId)
  await runHealthSignalChecks(report, cfg.portalBaseUrl)
  await runCookieFlagChecks(report, cfg.portalBaseUrl, app)

  // Never booted by the default run. Opt in with `npm run verify:login-failure`.
  for (const id of INVALID_KEY_IDS) {
    report.notExecuted(id, INVALID_KEY_DESCRIPTIONS[id], NOT_EXECUTED_OPT_IN)
  }

  return report
}
