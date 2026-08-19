/**
 * THE DECLARED ASSERTION INVENTORY. One entry per assertion id, for both runners.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------------------------------
 * Two people previously produced two different answers to "how many assertions are there",
 * and both were wrong, because the question was being answered by counting a DOCUMENT. Only
 * a minority of the ids below appear in `docs/VERIFICATION.md` in countable form: attack 2 has
 * no table at all, one call site in `03-stale-baseline.mjs` generates A FAMILY of assertions
 * from a loop, and the single `4.12` row in the doc is several assertions in the code. No
 * amount of care fixes that by hand. An unreproducible number is not a measurement.
 *
 * The figures that used to sit in this paragraph were accurate when written and had no
 * mechanism keeping them so — the same defect one file over. They are gone for that reason.
 *
 * So the disposition is COMPUTED from this file (`verify/lib/disposition.mjs`), printed by
 * the harness on every run, and written into `docs/VERIFICATION.md` only inside a generated,
 * machine-checked region. The document contains no hand-written count of anything the code
 * can count.
 *
 * ------------------------------------------------------------------------------------
 * THIS FILE IS DATA, AND DATA GOES STALE. THAT IS WHAT checkDrift IS FOR.
 * ------------------------------------------------------------------------------------
 * `checkDrift()` runs at the end of BOTH runners and compares this list against the ids the
 * run actually emitted, IN BOTH DIRECTIONS — emitted-but-not-declared and
 * declared-but-not-emitted. Any drift prints a MANIFEST DRIFT block and forces a non-zero
 * exit. If you add, remove or rename an assertion, the run tells you to edit this file; it
 * does not quietly disagree with you. Editing this file to silence a drift report you have
 * not understood defeats the entire mechanism.
 *
 * ------------------------------------------------------------------------------------
 * THE FIVE STATES
 * ------------------------------------------------------------------------------------
 *   live          executes against the target on that path, every run
 *   conditional   executes against the target when its precondition holds (PORTAL_BASE_URL
 *                 set, the app accepting the minted session, app_settings readable, a grant
 *                 present). Reported NOT EXECUTED with a reason when it does not.
 *   static        a labelled source-file assertion. Real, but it asserts the migration
 *                 SOURCE, not deployed state. Never counted as a live pass.
 *   not-executed  emitted every run, always as NOT EXECUTED with a printed reason. It is
 *                 permanently unreachable over that channel.
 *   absent        the id does not exist on that path at all.
 *
 * `optIn` marks an id that a THIRD, opt-in runner promotes to live — 5.5a/5.5b are
 * NOT EXECUTED in `npm run verify` and execute under `npm run verify:login-failure`, which
 * boots a second application instance with a deliberately invalid anon key.
 *
 * `alsoRuns` marks an id that a smaller runner executes as well as `npm run verify` — the
 * 5.1 predicate table needs no network, no credentials and no database, so
 * `npm run verify:login-predicate` runs it on its own and it is cheap enough to gate a commit.
 */

export const MANIFEST = [
  { id: '1.1',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.1b',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.2',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.3',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.3b',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.4',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.5',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.5b',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.6',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.7',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.7b',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.8',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.8b',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.9',       suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.10',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.11',      suite: 1, hosted: 'live',          local: 'live' },
  { id: '1.12',      suite: 1, hosted: 'static',        local: 'live' },

  { id: '2a.0',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2a.1',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.2',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.3',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.4',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.5',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.6',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.7',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.8',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.9',      suite: 2, hosted: 'not-executed',  local: 'live' },
  { id: '2a.10',     suite: 2, hosted: 'conditional',   local: 'not-executed' },
  { id: '2b.0',      suite: 2, hosted: 'live',          local: 'absent' },
  { id: '2b.1',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.2',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.2b',     suite: 2, hosted: 'live',          local: 'absent' },
  { id: '2b.3',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.4',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.5',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.6',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.7',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.8',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.9',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2b.10',     suite: 2, hosted: 'not-executed',  local: 'live' },

  { id: '3.0',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.1',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.1b',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.1c',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.2',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.2b',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.2c',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.2d',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.3',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.3b',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.4a',      suite: 3, hosted: 'conditional',   local: 'live' },
  { id: '3.4',       suite: 3, hosted: 'not-executed',  local: 'live' },
  { id: '3.4b',      suite: 3, hosted: 'not-executed',  local: 'live' },
  { id: '3.5',       suite: 3, hosted: 'not-executed',  local: 'live' },
  { id: '3.5b',      suite: 3, hosted: 'not-executed',  local: 'live' },
  { id: '3.5c',      suite: 3, hosted: 'not-executed',  local: 'live' },
  { id: '3.6a',      suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 interval', suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 age(',  suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 now() -', suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 current_date', suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 current_timestamp -', suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.6 older_than / expires / stale', suite: 3, hosted: 'static',        local: 'live' },
  { id: '3.7',       suite: 3, hosted: 'conditional',   local: 'live' },
  { id: '3.8',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.8b',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.8c',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.8d',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.8e',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.8f',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.9',       suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.9b',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.10',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.10b',     suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.11',      suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.11b',     suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.11c',     suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.11d',     suite: 3, hosted: 'live',          local: 'live' },
  { id: '3.11e',     suite: 3, hosted: 'live',          local: 'live' },

  { id: '4.1',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.2',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.3',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.4',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.5',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.5b',      suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.6',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.6b',      suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.7',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.8',       suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.9',       suite: 4, hosted: 'conditional',   local: 'not-executed' },
  { id: '4.10',      suite: 4, hosted: 'conditional',   local: 'not-executed' },
  { id: '4.10b',     suite: 4, hosted: 'not-executed',  local: 'absent' },
  { id: '4.11',      suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.11b',     suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.12a',     suite: 4, hosted: 'live',          local: 'live' },
  { id: '4.12b',     suite: 4, hosted: 'conditional',   local: 'live' },
  { id: '4.12c',     suite: 4, hosted: 'live',          local: 'live' },

  { id: '5.1.1',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.2',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.3',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.4',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.5',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.6',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.7',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.8',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.9',     suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.10',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.11',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.12',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.13',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.14',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.15',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.16',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.1.17',    suite: 5, hosted: 'live',          local: 'absent', alsoRuns: 'verify:login-predicate' },

  // 5.C — invariants between the 5.1 table and the predicate's own exported code sets. STATIC
  // on the hosted path because they assert the SHAPE of a source table, not deployed state;
  // absent locally because suite 5 has no local path at all. They therefore appear under
  // "Executes live on NEITHER path", which is correct and is explained in the disposition block.
  { id: '5.C1',      suite: 5, hosted: 'static',        local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.C2',      suite: 5, hosted: 'static',        local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.C3',      suite: 5, hosted: 'static',        local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.C4',      suite: 5, hosted: 'static',        local: 'absent', alsoRuns: 'verify:login-predicate' },
  { id: '5.C5',      suite: 5, hosted: 'static',        local: 'absent', alsoRuns: 'verify:login-predicate' },

  { id: '5.2a',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.2b',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.2c',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.3a',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.3b',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.3c',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.3d',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.4a',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.4b',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.4c',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.4d',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.5a',      suite: 5, hosted: 'not-executed',  local: 'absent', optIn: 'verify:login-failure' },
  { id: '5.5b',      suite: 5, hosted: 'not-executed',  local: 'absent', optIn: 'verify:login-failure' },
]

/** The four required attacks. Suite 5 is a regression suite and is counted separately. */
export const ATTACK_SUITES = [1, 2, 3, 4]
export const REGRESSION_SUITES = [5]

export const STATES = ['live', 'conditional', 'static', 'not-executed', 'absent']

/**
 * Ids a runner may emit that are NOT assertions in the inventory: setup-failure ids and the
 * blocked-report wildcard. They are error paths, not part of the declared id space.
 */
export const NON_INVENTORY_IDS = ['1.0']
export const NON_INVENTORY_PATTERN = /^\d+\.[!*]$/
