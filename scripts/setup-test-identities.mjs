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
 * IT REFUSES TO RUN IF THE TEST ADMIN COULD TAKE SEA-9003'S ATTRIBUTION
 * ------------------------------------------------------------------------------------
 * `supabase/seed/0003_seed_demo_delta.sql` credits SEA-9003's seeded manual override to the
 * EARLIEST admin profile by created_at. (Since 0025 it no longer creates a demo commitment.)
 * If the verification admin existed first it would be credited, and removing it afterwards
 * would leave the override unattributed (profiles ON DELETE SET NULL).
 *
 * The refusal is a POSITIVE probe: SEA-9003 must already carry an override_by that is not a
 * verification identity. See verify/hosted/lib/identity.mjs.
 *
 * The canonical order is:
 *   provision and sign in the real admin -> paste supabase/seed/0003_seed_demo_delta.sql ->
 *   only then create test identities and run the harness.
 */

import { loadConfig, configProofLines, NO_CONFIG, missingConfigDetail } from '../verify/hosted/lib/config.mjs'
import { buildIdentities } from '../verify/hosted/lib/client.mjs'
import {
  provisionIdentities,
  attributionVerdict,
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
  const verdict = await attributionVerdict(cfg, identities)
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
