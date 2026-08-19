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
 * The demo-delta interlock (run-order violation detector)
 * ==================================================================== */

export const DEMO_DELTA_NOTE = 'Demo delta: recorded in portal, not yet in QuickBooks'

export const VERDICT = {
  PROCEED: 'PROCEED',
  NO_DELTA_NO_COMMITMENTS: 'NO_DELTA_NO_COMMITMENTS',
  NO_DELTA_BUT_COMMITMENTS: 'NO_DELTA_BUT_COMMITMENTS',
  NO_REP_PROFILE: 'NO_REP_PROFILE',
  UNREADABLE: 'UNREADABLE',
}

/**
 * A POSITIVE PROBE, not a bare commitment count.
 *
 * A count alone waves through the worse state — unrelated commitments exist but
 * `supabase/seed/0003_seed_demo_delta.sql` never ran — because both look like "commitments
 * exist". The probe names the demo delta row by every identifying field instead.
 *
 * Three hazards, one predicate:
 *
 *   H1  a test rep becomes the EARLIEST rep profile, so 0003 binds the demo delta to an
 *       artefact Finisher must delete — and commitments.rep_id is ON DELETE RESTRICT, so
 *       that deletion is then blocked.
 *   H2  (dominant, and unconditional) 0003's guard is
 *       `IF EXISTS (SELECT 1 FROM public.commitments)` — NOT scoped by sku or location. The
 *       moment this harness writes its first commitment, even at location 'kyv-verify' on a
 *       KYV- sku, 0003 no-ops permanently and the demo delta can never be produced without
 *       someone manually deleting rows.
 *   H3  a test admin becomes the earliest admin, so it becomes SEA-9003's override_by;
 *       deleting it sets that column NULL (ON DELETE SET NULL) and the demo shows an
 *       unattributed override.
 *
 * The probe itself is a plain read. It creates nothing and is safe to run at any point.
 */
export async function demoDeltaVerdict(cfg, identities) {
  const svc = identities.service

  const delta = await selectRows(
    cfg,
    svc,
    'commitments',
    'select=id,rep_id,qty,state' +
      '&sku=eq.SEA-9007&location=eq.default&qty=eq.6&state=eq.pending' +
      `&note=eq.${encodeURIComponent(DEMO_DELTA_NOTE)}`,
  )
  if (!delta.ok) {
    return { verdict: VERDICT.UNREADABLE, detail: `${delta.code}: ${delta.message}`, probe: delta }
  }
  if (delta.rows.length > 0) {
    return { verdict: VERDICT.PROCEED, detail: 'the demo delta row is present', row: delta.rows[0] }
  }

  const all = await countRows(cfg, svc, 'commitments')
  const reps = await countRows(cfg, svc, 'profiles', 'role=eq.rep')

  if (reps.ok && reps.count === 0) {
    return { verdict: VERDICT.NO_REP_PROFILE, detail: 'no rep profile exists', anyCommit: all.count }
  }
  if (all.ok && all.count > 0) {
    return {
      verdict: VERDICT.NO_DELTA_BUT_COMMITMENTS,
      detail: `${all.count} commitment row(s) exist but the demo delta row does not`,
      anyCommit: all.count,
    }
  }
  return {
    verdict: VERDICT.NO_DELTA_NO_COMMITMENTS,
    detail: 'no commitments at all; 0003 has not been applied',
    anyCommit: all.count ?? 0,
  }
}

/** The refusal text for each verdict. Actionable, and specific about which state it saw. */
export function verdictMessage(v) {
  switch (v.verdict) {
    case VERDICT.PROCEED:
      return 'The demo delta is in place. 0003 has already run and bound to a real rep, so H1, H2 and H3 are all closed.'
    case VERDICT.NO_REP_PROFILE:
      return [
        'REFUSED: no rep profile exists — nobody has signed in yet.',
        '',
        'supabase/seed/0003_seed_demo_delta.sql binds the demo delta to the EARLIEST rep',
        'profile by created_at. Creating test identities now risks binding the demo to an',
        'artefact that gets deleted afterwards.',
        '',
        'Provision the real rep in the Supabase dashboard, have them sign in, paste',
        'supabase/seed/0003_seed_demo_delta.sql, then re-run this command. See README.md,',
        '"Running this against the hosted Supabase project", steps 4 to 7.',
      ].join('\n')
    case VERDICT.NO_DELTA_NO_COMMITMENTS:
      return [
        'REFUSED: the demo delta has not been applied.',
        '',
        'Creating test identities now risks binding it to a test artefact, and the first',
        'commitment this harness writes would make supabase/seed/0003_seed_demo_delta.sql',
        'no-op permanently — its guard is IF EXISTS (SELECT 1 FROM public.commitments),',
        'which is not scoped by sku or location.',
        '',
        'Provision and sign in the real rep, paste supabase/seed/0003_seed_demo_delta.sql,',
        'then re-run. See README.md, "Running this against the hosted Supabase project".',
      ].join('\n')
    case VERDICT.NO_DELTA_BUT_COMMITMENTS:
      return [
        'REFUSED: commitment rows exist but the demo delta row does not.',
        '',
        `Observed: ${v.detail}.`,
        '',
        'supabase/seed/0003_seed_demo_delta.sql will now no-op forever and cannot produce the',
        'demo delta. This needs a human decision — delete the offending commitments, or accept',
        'the demo without the delta. It is not a condition this script may resolve on its own.',
      ].join('\n')
    default:
      return `REFUSED: could not read the commitments table to check the demo delta (${v.detail}).`
  }
}
