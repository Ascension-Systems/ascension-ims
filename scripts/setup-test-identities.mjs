#!/usr/bin/env node
/**
 * `npm run verify:identities` — creates the two verification identities on the hosted
 * project and sets their roles. Idempotent; safe to re-run.
 *
 * Uses the service-role Admin API to create `rep.verify@example.invalid` and
 * `admin.verify@example.invalid`, upsert their `public.profiles` rows, and mint one real
 * session each to prove the mint path works before the harness depends on it.
 *
 * NO EMAIL IS SENT. NO PASSWORD IS SET. `createUser` is called without a password attribute
 * and `generateLink` type 'signup' is not used. Neither `createUser` nor `generateLink`
 * sends mail.
 *
 * ------------------------------------------------------------------------------------
 * IT REFUSES TO RUN IF THAT WOULD BIND THE DEMO DELTA TO A TEST ARTEFACT
 * ------------------------------------------------------------------------------------
 * `supabase/seed/0003_seed_demo_delta.sql` binds to the EARLIEST rep profile by created_at,
 * and no-ops entirely if ANY commitment row exists anywhere — its guard is
 * `IF EXISTS (SELECT 1 FROM public.commitments)`, not scoped by sku or location. So the
 * first commitment this harness writes, even at location 'kyv-verify' on a KYV- sku, would
 * suppress 0003 permanently.
 *
 * The refusal is driven by a THREE-WAY POSITIVE PROBE for the demo delta row, not by a bare
 * commitment count: a count alone waves through the worse state where unrelated commitments
 * exist but 0003 never ran. See verify/hosted/lib/identity.mjs.
 *
 * The canonical order is:
 *   provision and sign in the real rep -> paste supabase/seed/0003_seed_demo_delta.sql ->
 *   only then create test identities and run the harness.
 */

import { loadConfig, configProofLines, NO_CONFIG, missingConfigDetail } from '../verify/hosted/lib/config.mjs'
import { buildIdentities } from '../verify/hosted/lib/client.mjs'
import {
  provisionIdentities,
  demoDeltaVerdict,
  verdictMessage,
  VERDICT,
  REP_EMAIL,
  ADMIN_EMAIL,
} from '../verify/hosted/lib/identity.mjs'
import { runPreflight, VERDICTS } from '../verify/preflight.mjs'

const write = (s) => process.stdout.write(s)

async function main() {
  const cfg = loadConfig()

  write(
    [
      '',
      '='.repeat(78),
      'TEST IDENTITIES — create the two verification identities on the hosted project',
      '='.repeat(78),
      ...configProofLines(cfg),
      '',
    ].join('\n') + '\n',
  )

  if (!cfg.ok) {
    write(`${NO_CONFIG}\n\n${missingConfigDetail(cfg)}\n`)
    process.exitCode = 1
    return
  }

  // Schema and seed must be in place before identities mean anything. The identity probe
  // itself is skipped here — this script is what provisions them.
  const pre = await runPreflight(cfg, { requireIdentities: false })
  write(pre.lines.join('\n') + '\n\n')
  if (pre.verdict !== VERDICTS.OK) {
    write(`${pre.verdict}\n`)
    if (pre.detail) write(`\n${pre.detail}\n`)
    write('\nNothing was created.\n')
    process.exitCode = 1
    return
  }

  const identities = buildIdentities(cfg)

  // Belt and braces: runPreflight already checked this, but this script must never create an
  // identity on the strength of a check made somewhere else.
  const verdict = await demoDeltaVerdict(cfg, identities)
  if (verdict.verdict !== VERDICT.PROCEED) {
    write(`${verdictMessage(verdict)}\n\nNothing was created.\n`)
    process.exitCode = 1
    return
  }
  write(`${verdictMessage(verdict)}\n\n`)

  let minted
  try {
    minted = await provisionIdentities(cfg, identities)
  } catch (err) {
    write(`FAILED: ${err?.message ?? err}\n`)
    process.exitCode = 1
    return
  }

  write(
    [
      'CREATED / CONFIRMED',
      `  ${REP_EMAIL}`,
      `    auth user      : ${minted.rep.created ? 'created' : 'already existed'}`,
      `    profiles.role  : rep (upserted via service-role, not assumed from the trigger)`,
      `    session minted : yes (real GoTrue-issued JWT, held in memory, not written to disk)`,
      `  ${ADMIN_EMAIL}`,
      `    auth user      : ${minted.admin.created ? 'created' : 'already existed'}`,
      `    profiles.role  : admin (upserted via service-role)`,
      `    session minted : yes`,
      '',
      'Both addresses are on the reserved, non-routable example.invalid TLD: they cannot',
      'receive mail and cannot be mistaken for a person. No password was set for either;',
      'this project has none.',
      '',
      'Remove them, and everything the harness creates, with:',
      '  npm run verify:identities:remove',
      '',
      'Next: npm run verify',
      '',
    ].join('\n') + '\n',
  )
}

main().catch((err) => {
  write(`\nERROR: ${err?.stack ?? err?.message ?? err}\n`)
  process.exitCode = 1
})
