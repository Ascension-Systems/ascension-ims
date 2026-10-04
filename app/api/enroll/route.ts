import { NextResponse, after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'
import { headers } from 'next/headers'
import { notifyAdmins } from '@/lib/push'

/**
 * POST -> claim an invitation, set a password, and sign in. Self-serve onboarding for ~120 reps.
 *
 * A SHARED CODE THAT CANNOT LOG ANYONE IN. The code permits JOINING only, and is worthless on
 * its own: it must be paired with an address an admin already added to `invited_reps`. Every
 * account is a specific, invited rep, so identity is not negotiable here.
 *
 * NO EMAIL IS EVER SENT. The rep sets their own password and is signed in immediately. That is
 * the whole point -- no inbox to wait on, no link to click.
 *
 * SERVICE ROLE creates the account and claims the invitation (privileges no browser may hold).
 * Then the COOKIE-BOUND client signs the new user in with the password they just chose, so the
 * session cookies are set on this response and the browser is already logged in when it lands.
 *
 * FAILURE IS DELIBERATELY VAGUE. A precise "that address is not invited" would turn this public
 * endpoint into a roster oracle for the client's entire sales network. The server log carries
 * the real reason; the caller gets one message for every refusal.
 */

const REFUSAL =
  'That code and email did not match an open invitation. Check both with whoever sent you the code.'
const MIN_PASSWORD = 8

export async function POST(request: Request) {
  const requestHeaders = await headers()

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

  const { code, email, password } = (body ?? {}) as {
    code?: unknown
    email?: unknown
    password?: unknown
  }

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
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 128) {
    return NextResponse.json(
      { error: 'WEAK_PASSWORD', message: `Choose a password of at least ${MIN_PASSWORD} characters.` },
      { status: 400 },
    )
  }

  const cleanCode = code.trim()
  const cleanEmail = email.trim().toLowerCase()

  const admin = createAdminClient()

  // 1. Resolve the auth user. CRITICAL ORDERING: never set a password on a PRE-EXISTING account
  //    here. Authorisation (step 2) must run first — setting the password before the code and
  //    invitation are validated would let a bogus request overwrite ANY known account's password
  //    from just its email address, an unauthenticated account takeover (found in the pen test).
  //    A NEW account is created with the chosen password (there is no victim to overwrite); an
  //    EXISTING account's credentials are touched only after the claim succeeds (step 2b).
  let userId: string | null = null
  const created = await admin.auth.admin.createUser({
    email: cleanEmail,
    password,
    email_confirm: true,
  })

  if (created.error) {
    // Account already exists. Find it; leave its credentials untouched until authorised.
    const { data: list } = await admin.auth.admin.listUsers()
    userId = list?.users.find((u) => u.email?.toLowerCase() === cleanEmail)?.id ?? null
    if (!userId) {
      console.error('[enroll] createUser failed:', created.error.message)
      return NextResponse.json({ error: 'REFUSED', message: REFUSAL }, { status: 400 })
    }
  } else {
    userId = created.data.user.id
  }

  // 2. Validate the code AND the invitation together and provision, atomically under a row lock.
  //    For a pre-existing account no credential has changed yet, so a refusal here leaves it
  //    completely untouched.
  const { error: claimError } = await admin.rpc('claim_enrollment', {
    p_code: cleanCode,
    p_email: cleanEmail,
    p_user_id: userId,
  })

  if (claimError) {
    console.error('[enroll] claim refused:', claimError.code, claimError.message)
    // Delete ONLY an account we just created. A pre-existing account is never touched — not
    // deleted, and (per step 1) its password was never set.
    if (!created.error) {
      await admin.auth.admin.deleteUser(userId).catch(() => {})
    }
    return NextResponse.json({ error: 'REFUSED', message: REFUSAL }, { status: 400 })
  }

  // 2b. Authorised. If the account PRE-EXISTED (a rare unclaimed-invite edge), set the chosen
  //     password NOW — only after the claim succeeded. A new account already has it from step 1.
  if (created.error) {
    const { error: pwError } = await admin.auth.admin.updateUserById(userId, { password })
    if (pwError) {
      console.error('[enroll] set password failed:', pwError.message)
      return NextResponse.json(
        { ok: true, next: '/login', message: 'Your account is ready. Sign in with the password you just set.' },
        { status: 200 },
      )
    }
  }

  // Provisioned. Let the admins know the team grew — via after(), so it runs past the response
  // and never delays the new rep's sign-in. Fail-silent, never blocks enrollment.
  after(() =>
    notifyAdmins({
      title: 'New team member',
      body: `${cleanEmail} just set up their portal account.`,
      url: '/team',
    }),
  )

  // 3. Sign the new rep in with the password they just chose. The cookie-bound client sets the
  //    session cookies on THIS response, so the browser is logged in on arrival.
  const supabase = await createClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  })

  if (signInError) {
    // The account IS provisioned; they can simply sign in on the login page.
    console.error('[enroll] post-enroll sign-in failed:', signInError.message)
    return NextResponse.json(
      {
        ok: true,
        next: '/login',
        message: 'Your account is ready. Sign in with the password you just set.',
      },
      { status: 200 },
    )
  }

  return NextResponse.json({ ok: true, next: '/inventory' }, { status: 200 })
}
