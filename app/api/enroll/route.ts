import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { siteUrl } from '@/lib/env'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'
import { headers } from 'next/headers'

/**
 * POST -> claim an invitation and sign in. Self-serve onboarding for ~120 reps.
 *
 * A SHARED CODE THAT CANNOT LOG ANYONE IN. The code permits JOINING only, and is worthless
 * on its own: it must be paired with an address an admin already added to `invited_reps`.
 * Without that pairing a widely-shared code would let anyone enrol under a colleague's
 * address and own that identity. Every commitment is attributed to a specific rep, so
 * identity is not negotiable here.
 *
 * NO EMAIL IS SENT. The rep is signed in immediately. That is the entire point: Supabase's
 * built-in mailer is rate-capped and cannot serve 120 people, and a field rep standing in a
 * warehouse should not be waiting on an inbox to start working.
 *
 * THE SESSION IS ESTABLISHED BY THE EXISTING CALLBACK, NOT BY NEW CODE. After the account is
 * created this returns a one-time `token_hash` and the browser is sent to /auth/callback --
 * the same verified path a magic link uses, with its own allow-listed `next` handling and
 * open-redirect protection. No second session-handling implementation exists to drift.
 *
 * SERVICE ROLE, SERVER SIDE ONLY. Creating an auth user and claiming an invitation both
 * require privileges no browser may hold. `claim_enrollment` refuses any caller that is not
 * service_role, so even a leaked route cannot be driven from a rep session.
 *
 * FAILURE IS DELIBERATELY VAGUE TO THE CALLER. A precise "that address is not invited" would
 * turn this endpoint into a roster oracle for the client's entire sales network. The server
 * log carries the real reason; the caller gets one message for every refusal.
 */

const REFUSAL =
  'That code and email did not match an open invitation. Check both with whoever sent you the code.'

export async function POST(request: Request) {
  const requestHeaders = await headers()

  // Unauthenticated and public by necessity, so both tiers of the health/auth pattern apply:
  // an honest per-IP limit, plus a global ceiling a spoofed x-forwarded-for cannot escape.
  // Enrollment is a once-per-rep action, so these are generous and still bound a script.
  const ip = checkRateLimit('enroll:post', clientIpKey(requestHeaders), 5, 60_000)
  const global = checkRateLimit('enroll:post:global', 'all', 60, 60_000)
  if (!ip.allowed || !global.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' },
      { status: 429 },
    )
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 8_192) {
    return NextResponse.json(
      { error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
      { status: 413 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }

  const { code, email } = (body ?? {}) as { code?: unknown; email?: unknown }

  if (typeof code !== 'string' || code.trim().length < 8 || code.length > 128) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: REFUSAL }, { status: 400 })
  }
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: REFUSAL }, { status: 400 })
  }

  const cleanCode = code.trim()
  const cleanEmail = email.trim().toLowerCase()

  let site: string
  try {
    site = siteUrl()
  } catch (err) {
    console.error('[enroll] NEXT_PUBLIC_SITE_URL is not configured:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'UNAVAILABLE', message: 'Enrollment is not available right now.' },
      { status: 500 },
    )
  }

  const admin = createAdminClient()

  // 1. The auth user. email_confirm: true because the ALLOWLIST is the proof of identity --
  //    an admin already vouched for this address. Sending a confirmation email would
  //    reintroduce the exact dependency this flow exists to remove.
  let userId: string | null = null
  const created = await admin.auth.admin.createUser({ email: cleanEmail, email_confirm: true })

  if (created.error) {
    // An existing account is NOT an error worth distinguishing to the caller: it would reveal
    // who already has one. Look it up and let claim_enrollment decide -- it refuses a
    // second claim with KY014.
    const { data: list } = await admin.auth.admin.listUsers()
    userId = list?.users.find((u) => u.email?.toLowerCase() === cleanEmail)?.id ?? null
    if (!userId) {
      console.error('[enroll] createUser failed:', created.error.message)
      return NextResponse.json({ error: 'REFUSED', message: REFUSAL }, { status: 400 })
    }
  } else {
    userId = created.data.user.id
  }

  // 2. Validate the code AND the invitation together, then provision -- atomically, under a
  //    row lock, so two people racing the last use of a capped code cannot both succeed.
  const { error: claimError } = await admin.rpc('claim_enrollment', {
    p_code: cleanCode,
    p_email: cleanEmail,
    p_user_id: userId,
  })

  if (claimError) {
    // The real reason is logged; the caller gets one message for every refusal so this
    // endpoint cannot be used to enumerate the client's sales roster.
    console.error('[enroll] claim refused:', claimError.code, claimError.message)

    // Clean up an account we created that will never be usable. If the user already existed
    // (KY014, a second claim) we must NOT delete them -- that would let anyone with the code
    // delete a real rep's account.
    if (!created.error && claimError.code !== 'KY014') {
      await admin.auth.admin.deleteUser(userId).catch(() => {})
    }
    return NextResponse.json({ error: 'REFUSED', message: REFUSAL }, { status: 400 })
  }

  // 3. Hand off to the existing, verified callback rather than minting a session here.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: cleanEmail,
  })

  if (linkError || !link?.properties?.hashed_token) {
    console.error('[enroll] generateLink failed:', linkError?.message)
    // The account IS provisioned at this point, so this is recoverable by signing in normally.
    return NextResponse.json(
      {
        error: 'ENROLLED_NOT_SIGNED_IN',
        message: 'Your account is ready, but we could not sign you in automatically. Use the sign-in page.',
      },
      { status: 200 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      // Same shape a magic link uses. The callback owns session establishment and its own
      // open-redirect protection; nothing new is introduced here.
      next: `${site}/auth/callback?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=magiclink`,
    },
    { status: 200 },
  )
}
