/**
 * Test identities on the hosted project, and the ordering interlock that protects the demo.
 *
 * ------------------------------------------------------------------------------------
 * REAL SESSIONS, WITHOUT SENDING ANY EMAIL, WITHOUT SETTING ANY PASSWORD
 * ------------------------------------------------------------------------------------
 * This is the entire value of the hosted pass and the one thing embedded Postgres cannot
 * supply. The sequence, verified against the installed @supabase/supabase-js 2.112.3 rather
 * than from memory — the field names do not match the obvious guess:
 *
 *   1. admin.createUser({ email, email_confirm: true })       -- sends no email
 *   2. upsert the public.profiles row via service-role         -- see below, not optional
 *   3. admin.generateLink({ type: 'magiclink', email })        -- sends no email
 *      -> data.properties.hashed_token   (NOT `token_hash`; that is the verifyOtp argument)
 *   4. on a SEPARATE anon client:
 *      verifyOtp({ token_hash: <hashed_token>, type: 'magiclink' })
 *      -> a session carrying a real GoTrue-issued, real-signed JWT
 *
 * NO PASSWORD IS EVER SET. `createUser` is called without a `password` attribute and
 * `generateLink` type 'signup' (which requires one) is not used. Do not add one.
 *
 * WHY STEP 2 IS NOT OPTIONAL. README.md documents that `CREATE TRIGGER on_auth_user_created`
 * may be refused on a hosted project, with `ensure_profile()` as the fallback that runs on
 * sign-in. These identities never sign in through the app, so if the Human hit that case
 * `createUser` creates no profile at all and every rep/admin assertion fails with a
 * confusing foreign-key error instead of a policy result. The upsert closes that silent
 * failure — and setting `profiles.role` is required for the admin identity anyway.
 *
 * `admin.listUsers` has NO filter-by-email parameter and defaults to 50 per page, so every
 * idempotency lookup pages through.
 */

import { createClient } from '@supabase/supabase-js'
import { selectRows, upsertRows, countRows } from './client.mjs'

/* ==================================================================== *
 * Labelling — one prefix, applied everywhere, so removal is mechanical
 * ==================================================================== */

export const REP_EMAIL = 'rep.verify@example.invalid'
export const ADMIN_EMAIL = 'admin.verify@example.invalid'
export const TEST_EMAILS = [REP_EMAIL, ADMIN_EMAIL]

/** Written to user_metadata so an artefact is identifiable even if the address is missed. */
export const ARTEFACT_MARKER = { kyv_verification_artefact: true }

/**
 * `example.invalid` is a reserved, non-routable TLD. These addresses cannot receive mail and
 * cannot be mistaken for a person's. `scripts/check-no-secrets.sh` enforces that every email
 * address appearing under supabase/seed, verify/ and scripts/ uses it.
 */

/* ==================================================================== *
 * Clients
 * ==================================================================== */

/** Service-role client. Server-side only; the key never leaves this process. */
export function serviceClient(cfg) {
  return createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

/** A fresh anon client per mint, so two sessions can never share one client's state. */
export function freshAnonClient(cfg) {
  return createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

/* ==================================================================== *
 * Users
 * ==================================================================== */

/** Pages through listUsers; there is no server-side filter-by-email. */
export async function findUserByEmail(svc, email) {
  const target = email.toLowerCase()
  for (let page = 1; page <= 40; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`)
    const users = data?.users ?? []
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === target)
    if (hit) return hit
    if (users.length === 0) return null
  }
  return null
}

/**
 * Idempotent. Creates the auth user if absent, locates it if the address is already taken,
 * and always ends with a user id. Never sets a password.
 */
export async function ensureUser(svc, email) {
  const { data, error } = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: ARTEFACT_MARKER,
  })
  if (!error && data?.user) return { user: data.user, created: true }

  const existing = await findUserByEmail(svc, email)
  if (existing) return { user: existing, created: false }

  throw new Error(
    `could not create or locate the test identity ${email}: ${error?.message ?? 'unknown error'}`,
  )
}

/**
 * Upserts public.profiles via service-role. See the header: this is what closes the
 * "the trigger on auth.users was refused" silent-failure path.
 */
export async function upsertProfile(cfg, identities, { id, email, role }) {
  const res = await upsertRows(cfg, identities.service, 'profiles', [{ id, email, role }])
  if (!res.ok) {
    throw new Error(`could not upsert the profile row for ${email}: ${res.code} ${res.message}`)
  }
  return res.rows[0] ?? null
}

/** Mints a real, GoTrue-signed session. Held in memory only; nothing is written to disk. */
export async function mintSession(cfg, svc, email) {
  const { data, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`)

  const hashed = data?.properties?.hashed_token
  if (!hashed) {
    throw new Error(
      `generateLink returned no properties.hashed_token for ${email} — the installed ` +
        `@supabase/supabase-js does not expose the field this harness verified against.`,
    )
  }

  const anon = freshAnonClient(cfg)
  const verified = await anon.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' })
  if (verified.error) throw new Error(`verifyOtp failed for ${email}: ${verified.error.message}`)

  const session = verified.data?.session
  if (!session?.access_token) {
    throw new Error(`verifyOtp returned no session for ${email}`)
  }
  return session
}

/**
 * The full provisioning sequence for both identities.
 * Returns { rep: { user, session }, admin: { user, session } }.
 */
export async function provisionIdentities(cfg, identities) {
  const svc = serviceClient(cfg)

  const out = {}
  for (const [key, email, role] of [
    ['rep', REP_EMAIL, 'rep'],
    ['admin', ADMIN_EMAIL, 'admin'],
  ]) {
    const { user, created } = await ensureUser(svc, email)
    await upsertProfile(cfg, identities, { id: user.id, email, role })
    const session = await mintSession(cfg, svc, email)
    out[key] = { user, session, created, email, role }
  }
  return out
}

/* ==================================================================== *
 * The run-order interlock: SEA-9003 must already be attributed to a real admin
 * ==================================================================== */

/*
 * Since 0025 the portal records no commitments, so the old "demo delta" probe is gone. One
 * run-order hazard remains: supabase/seed/0003_seed_demo_delta.sql credits SEA-9003's seeded
 * manual override to the EARLIEST admin profile. If the verification admin were created first
 * it would be credited, and removing it afterwards (profiles ON DELETE SET NULL) would leave
 * the demo showing an unattributed override. So test identities may be created only once
 * SEA-9003 carries an override_by that is not a verification identity.
 *
 * A POSITIVE probe and a plain read: it creates nothing and is safe to run at any point.
 */

export const VERDICT = {
  PROCEED: 'PROCEED',
  NOT_ATTRIBUTED: 'NOT_ATTRIBUTED',
  ATTRIBUTED_TO_TEST_IDENTITY: 'ATTRIBUTED_TO_TEST_IDENTITY',
  UNREADABLE: 'UNREADABLE',
}

export async function attributionVerdict(cfg, identities) {
  const svc = identities.service
  const row = await selectRows(cfg, svc, 'inventory', 'select=override_by&sku=eq.SEA-9003&location=eq.default')
  if (!row.ok) {
    return { verdict: VERDICT.UNREADABLE, detail: `${row.code}: ${row.message}` }
  }
  const by = row.rows[0]?.override_by ?? null
  if (!by) {
    return { verdict: VERDICT.NOT_ATTRIBUTED, detail: 'SEA-9003 has no override_by' }
  }
  const owner = await selectRows(cfg, svc, 'profiles', `select=email&id=eq.${encodeURIComponent(by)}`)
  const email = owner.ok ? (owner.rows[0]?.email ?? null) : null
  if (email && TEST_EMAILS.includes(email)) {
    return { verdict: VERDICT.ATTRIBUTED_TO_TEST_IDENTITY, detail: `SEA-9003 is credited to ${email}` }
  }
  return { verdict: VERDICT.PROCEED, detail: 'SEA-9003 is credited to a real admin' }
}

/** The refusal text for each verdict. Actionable, and specific about which state it saw. */
export function verdictMessage(v) {
  switch (v.verdict) {
    case VERDICT.PROCEED:
      return 'SEA-9003 is attributed to a real admin; test identities cannot take its credit.'
    case VERDICT.NOT_ATTRIBUTED:
      return [
        'REFUSED: SEA-9003 has not been attributed yet.',
        '',
        'supabase/seed/0003_seed_demo_delta.sql credits it to the EARLIEST admin profile.',
        'Creating the verification admin now could make it that admin.',
        '',
        'Provision the real admin, have them sign in, paste supabase/seed/0003_seed_demo_delta.sql,',
        'then re-run. See README.md, "Running this against the hosted Supabase project".',
      ].join('\n')
    case VERDICT.ATTRIBUTED_TO_TEST_IDENTITY:
      return [
        `REFUSED: ${v.detail}.`,
        '',
        'This needs a human decision: re-attribute SEA-9003 to the real admin before continuing.',
      ].join('\n')
    default:
      return `REFUSED: could not read SEA-9003 to check attribution (${v.detail}).`
  }
}
