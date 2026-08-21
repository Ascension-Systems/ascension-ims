import { NextResponse } from 'next/server'
import { randomInt } from 'node:crypto'
import { requireAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST -> reset a user's password to a fresh strong temporary one. Admin only.
 *
 * WHY THIS EXISTS. There is no outbound email in this deployment (which is exactly why the app
 * signs in with passwords, not magic links). So a "forgot my password" is handled OUT OF BAND:
 * an admin resets the account here, reads the temporary password back ONCE, and relays it to the
 * person by whatever channel they already trust. The user signs in with it and may keep using it.
 *
 * WHAT THIS DELIBERATELY IS NOT.
 *  - It never accepts a password from the body. The admin does not choose the value; the server
 *    mints it. A chosen value is a misuse vector (weak, reused, or written down in the request)
 *    and buys nothing here.
 *  - It only ever changes the password. `updateUserById` is called with `{ password }` and
 *    nothing else — never role, email, or metadata. Privilege lives in `profiles.role` behind
 *    RLS and is untouched by an auth-password change.
 *  - It does not confirm or deny roster membership to anyone who is not already an admin. The
 *    whole route is behind requireAdmin() AND the service-role client is server-only, so the
 *    generic not-found below is defence in depth, not the boundary.
 *
 * Pattern mirrors app/api/invites/route.ts and app/api/codes/route.ts: requireAdmin ->
 * checkRateLimit(user.id) -> validate -> act. The service-role client is used because changing
 * another user's password is a privileged auth-admin operation with no cookie-bound equivalent.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// No ambiguous glyphs (0/O, 1/l/I) in any class, so a relayed password is transcribed correctly.
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*?-_+='
const ALL = LOWER + UPPER + DIGIT + SYMBOL
const LENGTH = 14

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!
}

/**
 * A 14-char password guaranteed to contain at least one of each class, with the remaining
 * characters drawn from the full alphabet and the whole thing shuffled so the guaranteed glyphs
 * are not pinned to fixed positions. Every draw uses crypto `randomInt`, never Math.random.
 */
function generateTempPassword(): string {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)]
  while (chars.length < LENGTH) chars.push(pick(ALL))
  // Fisher–Yates with a CSPRNG.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

export async function POST(request: Request) {
  const admin = await requireAdmin()
  if (!admin.ok) {
    const status = admin.reason === 'NOT_AUTHENTICATED' ? 401 : 403
    return NextResponse.json(
      {
        error: admin.reason,
        message:
          admin.reason === 'NOT_AUTHENTICATED'
            ? 'Sign in to continue.'
            : 'This action requires an admin account.',
      },
      { status },
    )
  }

  const rl = checkRateLimit('reset-password:post', admin.profile.id, 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }

  const { email } = (body ?? {}) as { email?: unknown }
  if (typeof email !== 'string' || email.trim().length === 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'An email address is required.' },
      { status: 400 },
    )
  }
  const target = email.trim().toLowerCase()
  if (target.length > 254 || !EMAIL.test(target)) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'That is not a valid email address.' },
      { status: 400 },
    )
  }

  const service = createAdminClient()

  // Find the auth user by email. listUsers is paginated (50/page); walk pages until we match or
  // run out. Email comparison is lower-cased on both sides — Supabase stores it lower-cased, but
  // we normalise ours regardless rather than depend on that.
  let userId: string | null = null
  const perPage = 200
  for (let page = 1; page <= 100 && !userId; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error('[api/reset-password] listUsers failed:', error.message)
      return NextResponse.json(
        { error: 'LOOKUP_FAILED', message: 'Could not look up that account. Try again.' },
        { status: 500 },
      )
    }
    const match = data.users.find((u) => (u.email ?? '').toLowerCase() === target)
    if (match) userId = match.id
    if (data.users.length < perPage) break // last page
  }

  // Generic not-found: do not distinguish "no such user" from "not enrolled". This route is
  // admin-only, so this is not the confidentiality boundary — it just avoids handing back a
  // roster-probe primitive by accident.
  if (!userId) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'No account was found for that email address.' },
      { status: 404 },
    )
  }

  const tempPassword = generateTempPassword()

  // ONLY the password. Never role, email, or metadata — see the header note.
  const { error: updateError } = await service.auth.admin.updateUserById(userId, {
    password: tempPassword,
  })
  if (updateError) {
    console.error('[api/reset-password] updateUserById failed:', updateError.message)
    return NextResponse.json(
      { error: 'RESET_FAILED', message: 'Could not reset the password. Try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, tempPassword }, { status: 200 })
}
