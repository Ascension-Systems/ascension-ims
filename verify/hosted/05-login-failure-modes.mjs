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
import { NOT_EXECUTED_NO_BASE_URL } from './lib/app-probe.mjs'

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

export async function runEnumerationEquivalence(report, baseUrl, runId) {
  if (!baseUrl) {
    notExecutedAll(report, EQUIVALENCE_IDS, EQUIVALENCE_DESCRIPTIONS, NOT_EXECUTED_NO_BASE_URL)
    return
  }

  const located = await locateLoginAction(baseUrl)
  if (!located.ok) {
    notExecutedAll(report, EQUIVALENCE_IDS, EQUIVALENCE_DESCRIPTIONS, located.reason)
    return
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
    notExecutedAll(
      report,
      EQUIVALENCE_IDS,
      EQUIVALENCE_DESCRIPTIONS,
      `NOT EXECUTED — the form POST to ${baseUrl}/login failed: ` +
        `${unregistered.error ?? registered.error}`,
    )
    return
  }

  // 5.4b sends a real magic link to a non-routable address and consumes that address's
  // throttle, so back-to-back runs can legitimately hit the per-address rate limit. That is
  // a re-run condition, not a failure of the system under test.
  if (
    isRateLimitRedirect(unregistered.location, baseUrl) ||
    isRateLimitRedirect(registered.location, baseUrl)
  ) {
    notExecutedAll(
      report,
      EQUIVALENCE_IDS,
      EQUIVALENCE_DESCRIPTIONS,
      'NOT EXECUTED — the per-address email throttle fired; re-run after the throttle window',
    )
    return
  }

  const u = locationParts(unregistered.location, baseUrl)
  const r = locationParts(registered.location, baseUrl)

  report.check(
    '5.4a',
    EQUIVALENCE_DESCRIPTIONS['5.4a'],
    u.path === '/login/check-email',
    `observed HTTP ${unregistered.status} -> ${unregistered.location}`,
  )
  report.check(
    '5.4b',
    EQUIVALENCE_DESCRIPTIONS['5.4b'],
    r.path === '/login/check-email',
    `observed HTTP ${registered.status} -> ${registered.location}`,
  )
  // THE assertion. Not "both look like success" but "the two responses are indistinguishable".
  report.check(
    '5.4c',
    EQUIVALENCE_DESCRIPTIONS['5.4c'],
    unregistered.location !== null &&
      unregistered.location === registered.location &&
      u.search === '' &&
      r.search === '',
    `unregistered ${JSON.stringify(unregistered.location)} vs registered ` +
      `${JSON.stringify(registered.location)}`,
  )
  report.check(
    '5.4d',
    EQUIVALENCE_DESCRIPTIONS['5.4d'],
    unregistered.status === registered.status,
    `unregistered HTTP ${unregistered.status} vs registered HTTP ${registered.status}`,
  )
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
 * The suite, as run by `npm run verify`
 * ==================================================================== */

export default async function suite5(ctx) {
  const { cfg } = ctx
  const report = new Report(SUITE_NUMBER, SUITE_TITLE, METHOD)
  const runId = newRunId()

  const compiled = await compilePredicate()
  runPredicateTable(report, compiled)

  await probeHostedErrorShape(report, cfg, compiled, runId)
  await runRenderChecks(report, cfg.portalBaseUrl)
  await runEnumerationEquivalence(report, cfg.portalBaseUrl, runId)

  // Never booted by the default run. Opt in with `npm run verify:login-failure`.
  for (const id of INVALID_KEY_IDS) {
    report.notExecuted(id, INVALID_KEY_DESCRIPTIONS[id], NOT_EXECUTED_OPT_IN)
  }

  return report
}
