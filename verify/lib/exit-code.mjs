/**
 * Exit codes that survive `embedded-postgres`.
 *
 * ------------------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR: `process.exitCode = 1` DID NOT FAIL THE PROCESS.
 * ------------------------------------------------------------------------------------
 * `verify:local` set `process.exitCode = 1` on failure and the process still exited 0,
 * so the suite could not fail an automated caller. Combined with the bootstrap failure
 * that stopped the four attacks from executing at all, every historical "verify:local
 * passed" carried no information whatsoever.
 *
 * THE MECHANISM, read out of the installed dependency rather than guessed:
 *
 *   1. node_modules/embedded-postgres/dist/index.js:397 calls `AsyncExitHook(gracefulShutdown)`
 *      at MODULE SCOPE — so merely importing the module arms this, whether or not a
 *      cluster is ever started.
 *   2. node_modules/async-exit-hook/index.js:90 then registers
 *      `add.hookEvent('beforeExit', 0)` — note the hard-coded 0.
 *   3. On natural event-loop drain Node fires `beforeExit`, index.js:116 calls
 *      `exit(true, 0)`, and index.js:24 runs `process.nextTick(process.exit.bind(null, 0))`.
 *
 * `process.exit(0)` takes an explicit argument, and an explicit argument OVERWRITES
 * `process.exitCode`. The failure is therefore not a race or a swallowed error: the
 * dependency deliberately exits 0 on the natural path, every time.
 *
 * Verified by execution, both directions:
 *   node -e 'await import("embedded-postgres"); process.exitCode = 1'   -> exits 0
 *   node -e 'process.exitCode = 1'                                      -> exits 1
 *
 * ------------------------------------------------------------------------------------
 * THE FIX: LEAVE THE NATURAL PATH; EXIT EXPLICITLY.
 * ------------------------------------------------------------------------------------
 * An explicit `process.exit(code)` is itself an explicit argument, so it wins over the
 * hook's, and it was verified to exit 1 with `embedded-postgres` imported. That is the
 * whole fix. What it is NOT:
 *
 *   - NOT a monkey-patch of `process.exit`. That would break a legitimate `exit(0)` and
 *     would make a future reader debug a lie.
 *   - NOT `AsyncExitHook.unhookEvent('beforeExit')`. That looks like the tidier fix and is
 *     worse: `gracefulShutdown` is registered as a HOOK, and on the `exit` event
 *     async-exit-hook takes its SYNCHRONOUS branch (index.js:40) and never awaits the
 *     cluster stops. Unhooking `beforeExit` would trade a wrong exit code for orphaned
 *     PostgreSQL processes and leaked temp directories.
 *
 * Callers must already have completed their own teardown (`shutdownDatabase()`) before
 * calling `exitWith` — it does not wait for the hook, because by design it does not reach
 * the natural path where the hook runs.
 *
 * THIS MODULE IMPORTS NO DATABASE CODE, and must not start doing so: a checker that
 * imports the thing it is defending against inherits the defect.
 */

/**
 * Hands every queued byte to the OS before exiting. `process.exit()` can truncate a pipe
 * mid-write, and a verdict line lost to truncation is exactly as bad as a wrong exit code.
 * An empty write is queued behind everything already written, so its callback firing means
 * the earlier chunks went out first.
 */
async function flush(stream) {
  if (!stream || stream.destroyed) return
  await new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    // Never hang a verdict on a stalled pipe: 2s is far beyond any local flush.
    const timer = setTimeout(done, 2000)
    if (timer.unref) timer.unref()
    try {
      stream.write('', () => {
        clearTimeout(timer)
        done()
      })
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}

/**
 * Exits with `code`, for real, even with `embedded-postgres` in the module graph.
 * Returns nothing; it does not return at all.
 */
export async function exitWith(code) {
  const status = Number.isInteger(code) ? code : code ? 1 : 0
  await flush(process.stdout)
  await flush(process.stderr)
  // Explicit argument. This is the line the whole module exists to justify.
  process.exit(status)
}

/* ==================================================================== *
 * Self-test — `node verify/lib/exit-code.mjs --self-test`
 *
 * Check the checker. It is not enough that this module looks right: the
 * property asserted here is the one a CI caller depends on, and it is
 * asserted by actually running child processes and reading their codes.
 * ==================================================================== */

const SELF_TEST_CASES = [
  {
    name: 'exitWith(1) exits 1 with embedded-postgres in the module graph',
    source: `
      await import('embedded-postgres')
      const { exitWith } = await import('./verify/lib/exit-code.mjs')
      process.stdout.write('child output that must not be truncated\\n')
      await exitWith(1)
    `,
    expect: 1,
    asserted: true,
  },
  {
    name: 'exitWith(0) still exits 0',
    source: `
      await import('embedded-postgres')
      const { exitWith } = await import('./verify/lib/exit-code.mjs')
      await exitWith(0)
    `,
    expect: 0,
    asserted: true,
  },
  {
    name: 'process.exitCode alone is still discarded by the dependency (informational)',
    source: `
      await import('embedded-postgres')
      process.exitCode = 1
    `,
    expect: 0,
    // NOT asserted. This documents the upstream defect the fix routes around. If a future
    // dependency bump fixes async-exit-hook, this case flips to 1 and that is GOOD NEWS,
    // not a regression — so it prints and never fails the self-test. Asserting it would
    // make the suite block on the defect being repaired, which is absurd.
    asserted: false,
  },
]

async function selfTest() {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

  process.stdout.write('\nexit-code.mjs --self-test\n')
  process.stdout.write('  Asserts that a nonzero exit SURVIVES embedded-postgres.\n\n')

  let failures = 0
  for (const c of SELF_TEST_CASES) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', c.source], {
      cwd: repo,
      encoding: 'utf8',
    })
    const got = res.status
    const ok = got === c.expect
    const label = c.asserted ? (ok ? 'PASS' : 'FAIL') : ok ? 'as documented' : 'CHANGED UPSTREAM'
    process.stdout.write(`  [${label}] ${c.name}\n`)
    process.stdout.write(`           expected exit ${c.expect}, observed ${got}\n`)
    if (c.expect === 1 && c.asserted && !res.stdout.includes('must not be truncated')) {
      process.stdout.write('           FAIL: child stdout was truncated by process.exit()\n')
      failures++
    }
    if (c.asserted && !ok) failures++
  }

  process.stdout.write(
    failures === 0
      ? '\n  exit-code self-test: PASS — a nonzero exit is reportable.\n\n'
      : `\n  exit-code self-test: FAIL — ${failures} problem(s).\n\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  await selfTest()
}
