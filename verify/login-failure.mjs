#!/usr/bin/env node
/**
 * `npm run verify:login-failure` — assertions 5.5a and 5.5b, the ones that cannot fire by
 * accident.
 *
 * ------------------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES: A BRANCH NOBODY EVER REACHES IS A BRANCH NOBODY EVER TESTS
 * ------------------------------------------------------------------------------------
 * The defect was that a bad or rotated anon key produced "check your email" for all ~120
 * reps. Nobody ever saw it, because everybody runs with a valid key. An assertion that
 * requires the key to be wrong therefore has to make it wrong DELIBERATELY, on purpose, in a
 * process that is not the one the operator is using.
 *
 * So this runner boots a SECOND copy of the application as a child process with a
 * deliberately invalid anon key, drives the login form against it over plain HTTP, and
 * asserts the user is told the truth:
 *
 *   5.5a  the response redirects to /login?error=unavailable, and specifically NOT to
 *         /login/check-email. Asserted as the exact expected value — "anything other than
 *         check-email" would also accept a 500 or a framework error page.
 *   5.5b  the server-side log line survived the fix.
 *
 * ------------------------------------------------------------------------------------
 * WHY IT IS OPT-IN AND NOT PART OF `npm run verify`
 * ------------------------------------------------------------------------------------
 * The default run must not boot a second application instance. In `npm run verify` both
 * assertions are emitted as NOT EXECUTED with the reason and a pointer to this command.
 *
 * ------------------------------------------------------------------------------------
 * WHY /login STILL RENDERS UNDER AN INVALID KEY (i.e. why the mechanism works at all)
 * ------------------------------------------------------------------------------------
 * `lib/supabase/middleware.ts:48-50` destructures only `data.user` and ignores the error, so
 * an invalid key yields `user = null`; `/login` is in PUBLIC_PATHS, so the request passes
 * through. The login page itself calls no Supabase API. Only the Server Action does.
 *
 * ------------------------------------------------------------------------------------
 * CREDENTIALS
 * ------------------------------------------------------------------------------------
 * No key, token or password is asked for or accepted. The child is given a literal that is
 * deliberately not key-shaped, and SUPABASE_SERVICE_ROLE_KEY is DELETED from its environment
 * — the child does not need it and must not receive it. Nothing derived from process.env is
 * printed.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` is passed through UNCHANGED, so the request reaches whatever
 * gateway the operator has configured and gets that gateway's real answer. Point it at a
 * non-routable host to exercise the same branch without contacting the hosted project:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=https://offline.example.invalid npm run verify:login-failure
 *
 * Both routes classify UNAVAILABLE and produce the same user-visible outcome — the real
 * gateway via `unavailable:401`, a non-routable host via `unavailable:network` — so 5.5a
 * holds either way and the run notes record which one was observed.
 *
 * Exit code 0 only if BOTH assertions executed and held. A NOT EXECUTED is never a pass, and
 * executing them is this command's entire purpose.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Report, STATUS } from './lib/report.mjs'
import { MANIFEST } from './lib/manifest.mjs'
import {
  computeDisposition,
  checkManifestIntegrity,
  checkDispositionSums,
  checkSubsetDrift,
  subsetDriftProblems,
  renderInvariantFailure,
} from './lib/disposition.mjs'
import { REPO, loadDotEnvLocal } from './hosted/lib/config.mjs'
import {
  DELIBERATELY_INVALID_KEY,
  SUITE_NUMBER,
  INVALID_KEY_IDS,
  INVALID_KEY_DESCRIPTIONS,
  newRunId,
  runInvalidKeyProbe,
} from './hosted/05-login-failure-modes.mjs'

const METHOD = `a second copy of this application is booted as a child process with a
deliberately invalid anon key and no service-role key; the login form is
submitted against it through the no-JS Server Action encoding; the Location
header and the child's own log output are asserted. The child is killed in a
finally block and again on SIGINT.`

const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 500

const write = (s) => process.stdout.write(s)

/** An ephemeral free port: bind :0, read what the OS gave us, release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForReady(baseUrl, deadline) {
  let lastError = 'no attempt was made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: 'manual' })
      if (res.status === 200) {
        await res.text()
        return { ok: true }
      }
      lastError = `GET /login answered HTTP ${res.status}`
    } catch (err) {
      lastError = err?.message ?? String(err)
    }
    await sleep(READY_POLL_MS)
  }
  return { ok: false, lastError }
}

async function main() {
  // Hydrates NEXT_PUBLIC_SUPABASE_URL from .env.local if it is not already in the environment.
  // It never overrides a value already set, so a command-line value always wins.
  loadDotEnvLocal(REPO)

  const report = new Report(
    SUITE_NUMBER,
    'Magic-link failure under a deliberately invalid anon key (opt-in)',
    METHOD,
  )
  const runId = newRunId()

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const reason =
      'NOT EXECUTED — NEXT_PUBLIC_SUPABASE_URL is not set, so the child would fail before ' +
      'reaching signInWithOtp and 5.5b could not observe the log line it asserts. Set it (a ' +
      'non-routable host such as https://offline.example.invalid is enough) and re-run.'
    for (const id of INVALID_KEY_IDS) report.notExecuted(id, INVALID_KEY_DESCRIPTIONS[id], reason)
    report.print('not started', { labelWord: 'Target', kindWord: 'SUITE' })
    process.exitCode = 1
    return
  }

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  // `next dev`, not `next start`: it reads NEXT_PUBLIC_* at runtime on the server, so no
  // rebuild is needed and there is no build-time inlining question. The local binary is
  // invoked directly rather than through npx, so resolution is deterministic and offline.
  const nextBin = join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next')

  const childEnv = { ...process.env, NEXT_PUBLIC_SUPABASE_ANON_KEY: DELIBERATELY_INVALID_KEY }
  delete childEnv.SUPABASE_SERVICE_ROLE_KEY
  delete childEnv.PORTAL_BASE_URL

  write(
    [
      '',
      '='.repeat(78),
      'LOGIN FAILURE MODES (5.5) — opt-in, deliberately invalid anon key',
      '='.repeat(78),
      'Mechanism    : a second application instance is booted as a child process with a',
      '               deliberately invalid anon key. The default `npm run verify` does NOT',
      '               boot it; there both assertions are NOT EXECUTED with this command named',
      '               as the way to run them.',
      `Child        : next dev on 127.0.0.1:${port} (ephemeral port)`,
      'Child env    : NEXT_PUBLIC_SUPABASE_ANON_KEY replaced with a deliberately invalid,',
      '               non-key-shaped literal; SUPABASE_SERVICE_ROLE_KEY DELETED;',
      '               NEXT_PUBLIC_SUPABASE_URL passed through unchanged.',
      '               (set / deleted only — no value, fragment, length or hash is printed.)',
      '',
    ].join('\n') + '\n',
  )

  const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: REPO,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  /**
   * Both streams are captured. Next's dev server routes some server-side console output
   * through its own logger, which does not always land on stderr, so 5.5b scans everything
   * the child said rather than guessing which stream it chose. The assertion is on the
   * CONTENT of the log line, which is what the fix has to preserve.
   */
  let output = ''
  const capture = (chunk) => {
    output += chunk.toString()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const kill = () => {
    if (!exited && child.pid) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  process.once('SIGINT', () => {
    kill()
    process.exit(130)
  })

  try {
    write(`  booting the child and waiting for GET /login (up to ${READY_TIMEOUT_MS / 1000}s)...\n`)
    const ready = await waitForReady(baseUrl, Date.now() + READY_TIMEOUT_MS)

    if (!ready.ok) {
      const reason =
        `NOT EXECUTED — the child application did not answer GET /login within ` +
        `${READY_TIMEOUT_MS / 1000}s (last: ${ready.lastError}). ` +
        (exited ? 'The child exited before becoming ready. ' : '') +
        'Nothing was asserted.'
      for (const id of INVALID_KEY_IDS) report.notExecuted(id, INVALID_KEY_DESCRIPTIONS[id], reason)
      report.notes.push(`child output, last 600 characters: ${JSON.stringify(output.slice(-600))}`)
    } else {
      write('  child is up. Submitting the login form.\n')
      await runInvalidKeyProbe(report, baseUrl, runId, () => output)
      // Report the ACTUAL cause, not an assumed one. The redirect to /login?error=unavailable
      // is produced both by a rejected key (signInWithOtp reached) and by a missing
      // NEXT_PUBLIC_SITE_URL (a throw before the send). Claiming "rejected the invalid key"
      // unconditionally would be a false note when the run never reached signInWithOtp.
      const reachedSend = /\[login\] signInWithOtp failed: unavailable:/.test(output)
      const threwBeforeSend =
        /\[login\] signInWithOtp threw:/.test(output) ||
        /Missing environment variable NEXT_PUBLIC_SITE_URL/.test(output)
      if (reachedSend && !threwBeforeSend) {
        report.notes.push(
          '5.5 exercised the real code path end to end in a single process: the form POST ' +
            'reached requestMagicLink, signInWithOtp failed against a gateway that rejected the ' +
            'invalid key, classifyAuthError classified it, and the redirect the user actually ' +
            'received was asserted. This is the branch a tester holding valid credentials can ' +
            'never reach by accident.',
        )
      } else {
        report.notes.push(
          '5.5 reached the /login?error=unavailable redirect, but the child stderr shows the ' +
            'cause was a PRE-SEND configuration throw (e.g. missing NEXT_PUBLIC_SITE_URL), not a ' +
            'rejected key. The redirect is correct; the key-rejection path was not exercised, and ' +
            '5.5a reflects that.',
        )
      }
    }
  } finally {
    kill()
  }

  report.print(`${baseUrl} (child process, deliberately invalid anon key)`, {
    labelWord: 'Target',
    kindWord: 'SUITE',
  })

  const notRun = report.results.filter((r) => r.status === STATUS.NOT_EXECUTED)
  if (notRun.length) {
    write(
      '\n  NOT EXECUTED — these did NOT run and must not be reported as passes:\n' +
        notRun.map((r) => `    ${r.id}  ${r.description}\n         reason: ${r.detail}`).join('\n') +
        '\n',
    )
  }

  /* ------------------------------------------------------------------ *
   * The manifest invariants, and this runner's reconciliation against
   * the slice of the manifest it owns (the opt-in ids). No config, no
   * network, no database — so it runs on every invocation.
   *
   * checkDrift is deliberately NOT used here — see checkSubsetDrift.
   * ------------------------------------------------------------------ */
  const integrity = checkManifestIntegrity(MANIFEST)
  if (!integrity.ok) {
    write(renderInvariantFailure('MANIFEST INTEGRITY — the declared inventory is malformed.', integrity.problems))
  }
  const sums = checkDispositionSums(computeDisposition(MANIFEST), MANIFEST)
  if (!sums.ok) {
    write(renderInvariantFailure('DISPOSITION SUM INVARIANT — the printed figures do not reconcile.', sums.problems))
  }
  const subset = checkSubsetDrift(
    MANIFEST,
    report,
    (e) => e.optIn === 'verify:login-failure',
    '`npm run verify:login-failure`',
  )
  if (!subset.ok) {
    write(
      renderInvariantFailure(
        'SUBSET DRIFT — this runner and the manifest disagree about which ids it owns.',
        subsetDriftProblems(subset),
      ),
    )
  }

  write('\n')

  process.exitCode =
    report.failed === 0 && notRun.length === 0 && integrity.ok && sums.ok && subset.ok ? 0 : 1
}

main().catch((err) => {
  write(`\nHARNESS ERROR: ${err?.stack ?? err?.message ?? err}\n`)
  process.exitCode = 1
})
