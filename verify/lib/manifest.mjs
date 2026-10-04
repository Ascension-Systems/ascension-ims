/**
 * THE DECLARED ASSERTION INVENTORY. One entry per assertion id, for both runners.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------------------------------
 * Two people previously produced two different answers to "how many assertions are there",
 * and both were wrong, because the question was being answered by counting a DOCUMENT. Only
 * a minority of the ids below appear in `docs/VERIFICATION.md` in countable form: attack 2 has
 * no table at all, one call site in the (since retired) `03-stale-baseline.mjs` generated A FAMILY of assertions
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

  { id: '2.1',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.2',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.3',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.4',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.5',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.6',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.7',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.8',       suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.8b',      suite: 2, hosted: 'live',          local: 'live' },
  { id: '2.9',       suite: 2, hosted: 'live',          local: 'live' },


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
  // 4.13 — the 0010 role guard proves itself independently of the 0012 grant. LIVE locally
  // (anon is deliberately granted EXECUTE on a disposable database and still gets KY003);
  // STATIC on hosted, because granting anon EXECUTE on a live project to prove a guard is a
  // real privilege change and is refused.
  { id: '4.13',      suite: 4, hosted: 'static',        local: 'live' },

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

  // 5.6 — the configuration health signal, GET /api/health/auth. The cost of the 2026-08-19
  // ruling, paid rather than absorbed. NO alsoRuns: verify:login-predicate — checkSubsetDrift
  // would then demand that runner emit these ids, and it cannot; it has no app to talk to.
  { id: '5.6a',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6b',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6c',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6d',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6e',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6f',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6g',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.6h',      suite: 5, hosted: 'conditional',   local: 'absent' },

  // 5.7 — the httpOnly measurement that the 2026-08-19 security pass OWES. httpOnly:true was
  // set on code evidence (zero importers of lib/supabase/client.ts, zero document.cookie) plus
  // a local mechanical probe; the behavioural SSR sign-in exercise the finding asked for was
  // not executable at build stage — no local auth server, hosted project off limits — so it
  // was scheduled here rather than claimed. NOT EXECUTED here means the measurement STILL has
  // not been taken.
  { id: '5.7a',      suite: 5, hosted: 'conditional',   local: 'absent' },
  { id: '5.7b',      suite: 5, hosted: 'conditional',   local: 'absent' },
]

/** The required attacks (3 was retired with 0025). Suite 5 is a regression suite, counted separately. */
// Suite 3 (stale baseline) was retired with migration 0025; 4 keeps its number.
export const ATTACK_SUITES = [1, 2, 4]
export const REGRESSION_SUITES = [5]

export const STATES = ['live', 'conditional', 'static', 'not-executed', 'absent']

/**
 * Ids a runner may emit that are NOT assertions in the inventory: setup-failure ids and the
 * blocked-report wildcard. They are error paths, not part of the declared id space.
 */
export const NON_INVENTORY_IDS = ['1.0']
export const NON_INVENTORY_PATTERN = /^\d+\.[!*]$/
