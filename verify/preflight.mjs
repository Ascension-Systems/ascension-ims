#!/usr/bin/env node
/**
 * `npm run verify:preflight` — READ-ONLY. CREATES NOTHING.
 *
 * ------------------------------------------------------------------------------------
 * "SCHEMA NOT APPLIED" IS ITS OWN ANSWER, NOT A FLAVOUR OF "NO CONFIGURATION"
 * ------------------------------------------------------------------------------------
 * Migrations 0001–0012 are applied to the hosted project by hand. A first hosted run will
 * find no tables at all. Conflating that with a missing environment variable wastes the
 * Human's time and sends them to the wrong dashboard page, so the two verdicts are distinct
 * strings and are never substituted for one another:
 *
 *   NOT EXECUTED — no Supabase configuration      (variables absent, or endpoint unreachable)
 *   NOT EXECUTED — schema not applied             (tables, view or functions missing)
 *   NOT EXECUTED — seed not applied               (schema present, catalogue absent)
 *   NOT EXECUTED — demo delta not applied, run order violated
 *   NOT EXECUTED — test identities not provisioned (run npm run verify:identities)
 *
 * A missing table surfaces from PostgREST as HTTP 404 with `code: 'PGRST205'`. This file
 * branches on that code, never on message text.
 *
 * `npm run verify` runs this first. It is also available standalone so the Human can find
 * out what is missing without writing anything anywhere.
 */

import { pathToFileURL } from 'node:url'
import { loadConfig, configProofLines, NO_CONFIG, missingConfigDetail } from './hosted/lib/config.mjs'
import { buildIdentities, selectRows, countRows, authHealth, openApiRoot } from './hosted/lib/client.mjs'
import {
  serviceClient,
  findUserByEmail,
  demoDeltaVerdict,
  verdictMessage,
  VERDICT,
  REP_EMAIL,
  ADMIN_EMAIL,
} from './hosted/lib/identity.mjs'

export const VERDICTS = {
  OK: 'OK',
  NO_CONFIG,
  NO_SCHEMA: 'NOT EXECUTED — schema not applied',
  NO_SEED: 'NOT EXECUTED — seed not applied',
  NO_DEMO_DELTA: 'NOT EXECUTED — demo delta not applied, run order violated',
  NO_IDENTITIES: 'NOT EXECUTED — test identities not provisioned (run npm run verify:identities)',
}

/** Which migration creates each table, so a missing one names its own fix. */
const TABLES = [
  ['profiles', '0002_profiles_and_role_helpers.sql'],
  ['products', '0003_products.sql'],
  ['inventory', '0004_inventory.sql'],
  ['commitments', '0005_commitments.sql'],
  ['app_settings', '0006_app_settings.sql'],
  ['inventory_sync_runs', '0007_inventory_sync_runs.sql'],
]

/** 90 generated catalogue rows + 7 pinned fixtures. KYV artefacts are excluded from the count. */
const EXPECTED_SEED_PRODUCTS = 97

const line = (label, verdict, note = '') =>
  `  ${label} ${'.'.repeat(Math.max(3, 46 - label.length))} ${verdict}${note ? `\n      ${note}` : ''}`

/**
 * Runs every probe. Returns { verdict, detail, lines, checkedIdentities }.
 * `requireIdentities: false` stops before the identity probe, for the standalone report.
 */
export async function runPreflight(cfg, { requireIdentities = true } = {}) {
  const lines = []

  if (!cfg.ok) {
    lines.push(line('configuration present', NO_CONFIG, missingConfigDetail(cfg)))
    return { verdict: NO_CONFIG, detail: missingConfigDetail(cfg), lines }
  }
  lines.push(line('configuration present', 'ok'))

  const identities = buildIdentities(cfg)

  /* --- reachability ------------------------------------------------ */
  const health = await authHealth(cfg)
  if (!health.ok) {
    const detail = `the endpoint could not be reached: ${health.message}`
    lines.push(line('endpoint reachable (GET /auth/v1/health)', NO_CONFIG, detail))
    return { verdict: NO_CONFIG, detail, lines }
  }
  lines.push(line('endpoint reachable (GET /auth/v1/health)', 'ok'))

  /* --- tables ------------------------------------------------------ */
  const missingTables = []
  for (const [table, migration] of TABLES) {
    const res = await selectRows(cfg, identities.service, table, 'select=*&limit=1')
    if (!res.ok && (res.code === 'PGRST205' || res.status === 404)) {
      missingTables.push(`${table} (supabase/migrations/${migration})`)
    } else if (!res.ok) {
      const detail = `reading public.${table} failed with ${res.code}: ${res.message}`
      lines.push(line(`table public.${table}`, NO_CONFIG, detail))
      return { verdict: NO_CONFIG, detail, lines }
    }
  }
  if (missingTables.length) {
    const detail = `missing: ${missingTables.join(', ')}`
    lines.push(line('tables 0002–0007 exist', VERDICTS.NO_SCHEMA, detail))
    return { verdict: VERDICTS.NO_SCHEMA, detail, lines }
  }
  lines.push(line('tables 0002–0007 exist', 'ok'))

  /* --- the view ---------------------------------------------------- */
  const view = await selectRows(cfg, identities.service, 'v_inventory', 'select=sku&limit=1')
  if (!view.ok && (view.code === 'PGRST205' || view.status === 404)) {
    const detail = 'public.v_inventory is missing (supabase/migrations/0008_inventory_view.sql)'
    lines.push(line('view public.v_inventory exists', VERDICTS.NO_SCHEMA, detail))
    return { verdict: VERDICTS.NO_SCHEMA, detail, lines }
  }
  // A 42501 here is not "missing": it means service_role lacks SELECT on the view, which the
  // runner resolves by falling back to the admin session as the availability oracle.
  lines.push(
    line(
      'view public.v_inventory exists',
      'ok',
      view.ok ? '' : `readable by service_role: no (${view.code}); the run falls back to the admin session as the oracle`,
    ),
  )

  /* --- functions are exposed as RPCs -------------------------------- */
  const api = await openApiRoot(cfg, identities.service)
  const wantedRpcs = [
    ['/rpc/record_commitment', '0009_fn_record_commitment.sql'],
    ['/rpc/apply_inventory_sync', '0010_fn_apply_inventory_sync.sql'],
  ]
  if (api.ok) {
    const missingRpcs = wantedRpcs
      .filter(([path]) => !api.paths.includes(path))
      .map(([path, mig]) => `${path} (supabase/migrations/${mig})`)
    if (missingRpcs.length) {
      const detail = `not exposed: ${missingRpcs.join(', ')}`
      lines.push(line('RPCs exposed by PostgREST', VERDICTS.NO_SCHEMA, detail))
      return { verdict: VERDICTS.NO_SCHEMA, detail, lines }
    }
    lines.push(line('RPCs exposed by PostgREST', 'ok'))
  } else {
    lines.push(
      line(
        'RPCs exposed by PostgREST',
        'unverified',
        `the OpenAPI root was not readable (${api.message}); the RPC calls themselves will report any absence`,
      ),
    )
  }

  /* --- app_settings singleton --------------------------------------- */
  const settings = await selectRows(cfg, identities.service, 'app_settings', 'select=inventory_authority')
  if (!settings.ok || settings.rowCount !== 1) {
    const detail = `expected exactly 1 app_settings row, observed ${settings.ok ? settings.rowCount : `error ${settings.code}`} (supabase/migrations/0006_app_settings.sql)`
    lines.push(line('app_settings singleton row', VERDICTS.NO_SCHEMA, detail))
    return { verdict: VERDICTS.NO_SCHEMA, detail, lines }
  }
  lines.push(line('app_settings singleton row', 'ok'))

  /* --- seed --------------------------------------------------------- */
  const products = await countRows(cfg, identities.service, 'products', 'sku=not.like.KYV-*')
  if (!products.ok || products.count < EXPECTED_SEED_PRODUCTS) {
    const detail =
      `expected at least ${EXPECTED_SEED_PRODUCTS} catalogue products (90 generated + 7 pinned), observed ` +
      `${products.ok ? products.count : `error ${products.code}`}. Apply supabase/seed/0001_seed_catalogue.sql ` +
      'and supabase/seed/0002_seed_fixtures.sql.'
    lines.push(line('seed 0001 + 0002 applied', VERDICTS.NO_SEED, detail))
    return { verdict: VERDICTS.NO_SEED, detail, lines }
  }
  lines.push(line('seed 0001 + 0002 applied', 'ok', `${products.count} catalogue products`))

  /* --- the demo delta, and the run-order interlock ------------------- */
  const delta = await demoDeltaVerdict(cfg, identities)
  if (delta.verdict !== VERDICT.PROCEED) {
    const detail = verdictMessage(delta)
    lines.push(line('demo delta (supabase/seed/0003) applied', VERDICTS.NO_DEMO_DELTA, detail))
    return { verdict: VERDICTS.NO_DEMO_DELTA, detail, lines }
  }
  lines.push(line('demo delta (supabase/seed/0003) applied', 'ok'))

  if (!requireIdentities) {
    return { verdict: VERDICTS.OK, detail: null, lines }
  }

  /* --- test identities ---------------------------------------------- */
  let repUser = null
  let adminUser = null
  try {
    const svc = serviceClient(cfg)
    repUser = await findUserByEmail(svc, REP_EMAIL)
    adminUser = await findUserByEmail(svc, ADMIN_EMAIL)
  } catch (err) {
    const detail = `the GoTrue admin API could not be queried: ${err?.message ?? err}`
    lines.push(line('test identities exist', NO_CONFIG, detail))
    return { verdict: NO_CONFIG, detail, lines }
  }

  if (!repUser || !adminUser) {
    const absent = [!repUser && REP_EMAIL, !adminUser && ADMIN_EMAIL].filter(Boolean).join(', ')
    const detail = `not provisioned: ${absent}. Run \`npm run verify:identities\`.`
    lines.push(line('test identities exist', VERDICTS.NO_IDENTITIES, detail))
    return { verdict: VERDICTS.NO_IDENTITIES, detail, lines }
  }
  lines.push(line('test identities exist', 'ok'))

  return { verdict: VERDICTS.OK, detail: null, lines, users: { rep: repUser, admin: adminUser } }
}

/* ==================================================================== *
 * Standalone entry point
 * ==================================================================== */

async function main() {
  const cfg = loadConfig()

  process.stdout.write(
    [
      '',
      '='.repeat(78),
      'PREFLIGHT — read-only. Creates nothing, writes nothing, deletes nothing.',
      '='.repeat(78),
      ...configProofLines(cfg),
      '',
    ].join('\n') + '\n',
  )

  const result = await runPreflight(cfg)
  process.stdout.write(result.lines.join('\n') + '\n\n')

  if (result.verdict === VERDICTS.OK) {
    process.stdout.write(
      'PREFLIGHT OK — the hosted project has the schema, the seed, the demo delta and the test\n' +
        'identities the harness needs. `npm run verify` can run.\n',
    )
    process.exitCode = 0
    return
  }

  process.stdout.write(`${result.verdict}\n`)
  if (result.detail) process.stdout.write(`\n${result.detail}\n`)
  process.stdout.write(
    '\nSee README.md, "Running this against the hosted Supabase project", for the ordered\n' +
      'procedure. Nothing was written to the project.\n',
  )
  process.exitCode = 1
}

// Runs main() only when this file IS the entry point; `npm run verify` imports runPreflight.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`\nPREFLIGHT ERROR: ${err?.stack ?? err?.message ?? err}\n`)
    process.exitCode = 1
  })
}
