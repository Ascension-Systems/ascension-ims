#!/usr/bin/env node
/**
 * `npm run verify` — the four required attacks against the CONFIGURED HOSTED SUPABASE
 * PROJECT, over HTTPS, using real GoTrue-issued sessions.
 *
 * ------------------------------------------------------------------------------------
 * THE ONE RULE: NEVER PRINT PASS FOR ANYTHING NOT ACTUALLY EXECUTED.
 * ------------------------------------------------------------------------------------
 * Every assertion ends in exactly one of four states and there is no fifth:
 *
 *   PASS / FAIL   executed against the hosted project
 *   STATIC        executed against the committed migration SOURCE, labelled as such
 *   NOT EXECUTED  did not run, with the reason printed here and again in the summary
 *
 * NO SILENT FALLBACK TO LOCAL, EVER. If configuration is missing or the endpoint is
 * unreachable, every affected attack prints `NOT EXECUTED — no Supabase configuration` and
 * this command exits non-zero. It does not select the embedded-Postgres path, does not
 * import verify/lib/harness.mjs, and offers `npm run verify:local` only as a separate
 * suggestion — never as a fallback.
 *
 * Totals are computed from what actually ran. No expected assertion count is hard-coded
 * anywhere in this file or in anything it imports.
 */

import { loadConfig, configProofLines, NO_CONFIG, missingConfigDetail } from './hosted/lib/config.mjs'
import { Report, blockedReport, STATUS } from './lib/report.mjs'
import { buildIdentities, resolveInventoryOracle } from './hosted/lib/client.mjs'
import { provisionIdentities } from './hosted/lib/identity.mjs'
import { probeAppSession } from './hosted/lib/app-probe.mjs'
import { resetFixtures, teardownFixtures, ARTEFACT_DISCLOSURE } from './hosted/lib/fixtures.mjs'
import { runPreflight, VERDICTS } from './preflight.mjs'
import attack1 from './hosted/01-rls-bypass.mjs'
import attack2 from './hosted/02-concurrent-last-unit.mjs'
import attack3 from './hosted/03-stale-baseline.mjs'
import attack4 from './hosted/04-role-enforcement.mjs'
import suite5, { SUITE_TITLE as SUITE5_TITLE } from './hosted/05-login-failure-modes.mjs'
import { MANIFEST } from './lib/manifest.mjs'
import {
  checkDrift,
  renderDrift,
  computeDisposition,
  renderDispositionBlock,
} from './lib/disposition.mjs'

const ATTACKS = [
  [1, 'RLS bypass', attack1],
  [2, 'Concurrent commitment on the last unit', attack2],
  [3, 'Delta survives a stale baseline', attack3],
  [4, 'Role enforcement is server-side', attack4],
]

const BLOCKED_METHOD = 'not attempted — see the reason on the assertion line below.'

/**
 * Suite 5 is a REGRESSION SUITE, NOT A FIFTH ATTACK. The brief requires four attacks and this
 * document set is structured around those four; suite 5 covers the magic-link request path's
 * failure modes and is printed after them, counted separately, in the same way check:secrets
 * is explicitly not one of the four.
 */
const REGRESSION = [5, SUITE5_TITLE, suite5]

const RLS_SEMANTICS_NOTE = `
  A NOTE ON HOW A REFUSAL IS ASSERTED. Postgres raises 42501 for an INSERT that violates a
  WITH CHECK policy, and for any command whose table GRANT the role lacks. It does NOT raise
  for an UPDATE or DELETE that an RLS USING clause filters out — those report 0 rows and no
  error. This harness does not accept "no error and 0 rows" on its own. For every filtered
  write it asserts three things together: 0 rows affected, the target row unchanged on an
  independent service-role re-read, and the IDENTICAL request succeeding as admin. That is
  strictly stronger evidence than a bare SQLSTATE check, and it is what distinguishes a
  working policy from a blanket denial.`

const LOCAL_SUGGESTION = `
  SEPARATELY, AND NOT AS A FALLBACK: \`npm run verify:local\` runs the same four attacks
  against an ephemeral local PostgreSQL server. It exercises POLICY LOGIC ONLY — it does not
  cover identity issuance, JWT signing, JWT verification, PostgREST request handling or
  session handling, and a pass there is never a claim about the hosted project. It is the
  only place attack 2a's deterministic lock interleaving can run.`

const write = (s) => process.stdout.write(s)

function banner(cfg, extra = []) {
  write(
    [
      '',
      '='.repeat(78),
      'VERIFICATION HARNESS (HOSTED) — the four required attacks',
      '='.repeat(78),
      'Target        : the configured hosted Supabase project, over HTTPS.',
      'Channel       : PostgREST /rest/v1 + /rest/v1/rpc, GoTrue /auth/v1. No database',
      '                connection string is used, requested or accepted anywhere.',
      'Also printed  : SUITE 5, a regression suite for the magic-link request path. It comes',
      '                after the four and is counted separately. IT IS NOT A FIFTH ATTACK.',
      '',
      ...configProofLines(cfg),
      ...extra,
      '',
    ].join('\n') + '\n',
  )
}

/** Prints a per-attack NOT EXECUTED verdict for all four, then the summary, then exits 1. */
function abort(reason, detail) {
  const reports = ATTACKS.map(([n, title]) => blockedReport(n, title, BLOCKED_METHOD, reason))
  for (const r of reports) r.print(reason, { labelWord: 'Target' })
  const regression = blockedReport(REGRESSION[0], REGRESSION[1], BLOCKED_METHOD, reason, {
    kindWord: 'suite',
  })
  regression.print(reason, { labelWord: 'Target', kindWord: 'SUITE' })
  summarise(reports, { aborted: reason, abortDetail: detail, regression })
  process.exitCode = 1
}

function summarise(
  reports,
  { aborted = null, abortDetail = null, extraNotes = [], regression = null } = {},
) {
  // The four attacks are totalled as the four attacks. Suite 5 is reported separately and is
  // never folded into that figure, so "the four attacks" keeps its meaning.
  const totalExecuted = reports.reduce((n, r) => n + r.executed, 0)
  const totalPassed = reports.reduce((n, r) => n + r.passed, 0)
  const totalFailed = reports.reduce((n, r) => n + r.failed, 0)
  const totalStatic = reports.reduce((n, r) => n + r.statics, 0)
  const totalNotRun = reports.reduce((n, r) => n + r.notRun, 0)

  const line = (word, r) =>
    r.blocked
      ? `  ${word} ${r.number}  ${r.title.padEnd(42)} ${r.blocked}`
      : `  ${word} ${r.number}  ${r.title.padEnd(42)} ${r.ok ? 'PASS' : 'FAIL'}  (${r.passed}/${r.executed} executed` +
        `${r.statics ? `, ${r.statics} static` : ''}${r.notRun ? `, ${r.notRun} not executed` : ''})`

  write(
    [
      '',
      '='.repeat(78),
      'SUMMARY — npm run verify (hosted)',
      '='.repeat(78),
      ...reports.map((r) => line('Attack', r)),
      '',
      `  Executed against the hosted project : ${totalPassed} passed, ${totalFailed} failed, of ${totalExecuted}.`,
      `  STATIC (migration source, not deployed state) : ${totalStatic}.`,
      `  NOT EXECUTED (never counted as a pass)        : ${totalNotRun}.`,
      '',
      ...(regression
        ? [
            '  SEPARATELY — not one of the four required attacks:',
            line('Suite ', regression),
            '',
          ]
        : []),
    ].join('\n') + '\n',
  )

  // Suite 5's own NOT EXECUTED and STATIC entries are listed with everyone else's below: a
  // non-execution that is not printed is a non-execution that gets forgotten.
  if (regression) reports = [...reports, regression]

  if (aborted) {
    write(`  ${aborted}\n`)
    if (abortDetail) write(`  ${abortDetail.split('\n').join('\n  ')}\n`)
    write('\n')
  }

  if (totalNotRun) {
    write(
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

  if (totalStatic) {
    write(
      [
        '  STATIC — these asserted the committed migration SOURCE, not the deployed database:',
        ...reports.flatMap((r) =>
          r.results
            .filter((x) => x.status === STATUS.STATIC)
            .map((x) => `    ${x.id}  ${x.description}`),
        ),
        '    The deployed-object equivalents (pg_class reloptions, pg_get_functiondef) need',
        '    pg_catalog, which PostgREST does not expose. They run under `npm run verify:local`.',
        '',
      ].join('\n') + '\n',
    )
  }

  const notes = [...reports.flatMap((r) => r.notes ?? []), ...extraNotes]
  if (notes.length) {
    write(['  RUN NOTES:', ...notes.map((n) => `    ${n}`), ''].join('\n') + '\n')
  }

  write(RLS_SEMANTICS_NOTE.trimEnd() + '\n')
  write(LOCAL_SUGGESTION.trimEnd() + '\n\n')
}

async function main() {
  const cfg = loadConfig()

  /* ---------------------------------------------------------------- *
   * 1. Configuration. No configuration means no run — never a fallback.
   * ---------------------------------------------------------------- */
  if (!cfg.ok) {
    banner(cfg)
    abort(NO_CONFIG, missingConfigDetail(cfg))
    return
  }

  banner(cfg)

  /* ---------------------------------------------------------------- *
   * 2. Preflight. Read-only; distinguishes "no configuration" from
   *    "schema not applied" from "seed not applied" from "run order
   *    violated" from "identities not provisioned".
   * ---------------------------------------------------------------- */
  write('PREFLIGHT (read-only)\n')
  const pre = await runPreflight(cfg)
  write(pre.lines.join('\n') + '\n\n')

  if (pre.verdict !== VERDICTS.OK) {
    abort(pre.verdict, pre.detail)
    return
  }

  /* ---------------------------------------------------------------- *
   * 3. Identities. Two real, GoTrue-signed sessions, minted without
   *    sending an email and without setting any password.
   * ---------------------------------------------------------------- */
  let identities = buildIdentities(cfg)
  let minted
  try {
    minted = await provisionIdentities(cfg, identities)
  } catch (err) {
    abort(NO_CONFIG, `test identities could not be minted: ${err?.message ?? err}`)
    return
  }

  identities = buildIdentities(cfg, {
    repAccessToken: minted.rep.session.access_token,
    adminAccessToken: minted.admin.session.access_token,
  })

  const oracle = await resolveInventoryOracle(cfg, identities)

  // The KYV fixtures are created once here, before the app probe, so the probe's
  // precondition (an impossible quantity against a fixture whose availability is 1) gets the
  // 409 it is designed to discriminate on rather than a 404 for a missing sku. Every attack
  // resets them again at its own start, so the four stay independent of each other.
  try {
    await resetFixtures(cfg, identities)
  } catch (err) {
    abort(NO_CONFIG, `the KYV fixtures could not be created: ${err?.message ?? err}`)
    return
  }

  const app = await probeAppSession(cfg, minted.rep.session)

  write(
    [
      'IDENTITIES',
      '  rep   : rep.verify@example.invalid   — real GoTrue session, profiles.role = rep',
      '  admin : admin.verify@example.invalid — real GoTrue session, profiles.role = admin',
      '  Sessions are held in memory for this run only. No password was set for either.',
      '',
      'AVAILABILITY ORACLE',
      `  ${oracle.label}`,
      '',
      'APPLICATION UNDER TEST (2a.10, 4.9, 4.10, 5.3, 5.4)',
      app.usable
        ? `  reachable and the minted rep session is accepted. ${app.detail}`
        : `  ${app.reason}${app.detail ? `\n  ${app.detail}` : ''}`,
      '',
      ...ARTEFACT_DISCLOSURE.map((l) => `  ${l}`),
      '',
    ].join('\n') + '\n',
  )

  if (!oracle.identity) {
    abort(
      NO_CONFIG,
      `public.v_inventory could not be read by service_role or by the admin session — ${oracle.label}`,
    )
    return
  }

  /* ---------------------------------------------------------------- *
   * 4. The four attacks.
   * ---------------------------------------------------------------- */
  const ctx = {
    cfg,
    identities,
    oracle,
    app,
    uids: { rep: minted.rep.user.id, admin: minted.admin.user.id },
  }

  const targetLabel = `hosted Supabase project ${cfg.projectRef} (PostgREST + GoTrue over HTTPS)`
  const reports = []
  let hardError = null

  try {
    for (const [number, title, attack] of ATTACKS) {
      let report
      try {
        report = await attack(ctx)
      } catch (err) {
        report = new Report(number, title, BLOCKED_METHOD)
        report.fail(`${number}.!`, `attack ${number} raised before completing`, err?.stack ?? String(err))
      }
      report.print(targetLabel, { labelWord: 'Target' })
      reports.push(report)
    }
  } catch (err) {
    hardError = err
  }

  /* ---------------------------------------------------------------- *
   * 5. Suite 5 — the magic-link failure-mode regression suite. Printed
   *    after the four, counted separately, and never called an attack.
   * ---------------------------------------------------------------- */
  let regression = null
  if (!hardError) {
    const [number, title, suite] = REGRESSION
    try {
      regression = await suite(ctx)
    } catch (err) {
      regression = new Report(number, title, BLOCKED_METHOD)
      regression.fail(`${number}.!`, `suite ${number} raised before completing`, err?.stack ?? String(err))
    }
    regression.print(targetLabel, { labelWord: 'Target', kindWord: 'SUITE' })
  }

  /* ---------------------------------------------------------------- *
   * 6. Teardown of this run's fixture rows. The test identities and any
   *    commitments they own survive deliberately — removing them is
   *    `npm run verify:identities:remove`, which is a separate, explicit
   *    step so a re-run does not have to re-mint sessions.
   * ---------------------------------------------------------------- */
  const teardownNotes = []
  try {
    const removed = await teardownFixtures(cfg, identities)
    teardownNotes.push(
      `Teardown removed ${removed.commitments} commitment row(s) in the KYV namespace ` +
        `(location 'kyv-verify', location 'kyv-verify-2', and any commitment on a KYV- sku at ` +
        `any other location) and ${removed.products} KYV- product(s) (cascading their ` +
        `inventory rows). The two test ` +
        `identities and the inventory_sync_runs rows this run created REMAIN — remove them with ` +
        `\`npm run verify:identities:remove\`.`,
    )
  } catch (err) {
    teardownNotes.push(
      `TEARDOWN FAILED: ${err?.message ?? err}. KYV- rows may remain on the project. Run ` +
        `\`npm run verify:identities:remove\`, or use the manual SQL in README.md step 11.`,
    )
  }

  if (hardError) {
    write(`\nHARNESS ERROR: ${hardError.stack ?? hardError.message}\n`)
  }

  summarise(reports, { extraNotes: teardownNotes, regression })

  /* ---------------------------------------------------------------- *
   * 7. Manifest drift, both directions, then the one authoritative
   *    disposition — computed here, never hand-counted anywhere.
   * ---------------------------------------------------------------- */
  const drift = checkDrift(MANIFEST, regression ? [...reports, regression] : reports, 'hosted')
  write(renderDrift(drift))
  write('\n' + renderDispositionBlock(computeDisposition(MANIFEST)) + '\n\n')

  const anyFailed = [...reports, ...(regression ? [regression] : [])].some((r) => !r.ok)
  const anyBlocking = reports.some((r) => r.isBlocked)
  process.exitCode = hardError || anyFailed || anyBlocking || !drift.ok ? 1 : 0
}

main().catch((err) => {
  write(`\nHARNESS ERROR: ${err?.stack ?? err?.message ?? err}\n`)
  process.exitCode = 1
})
