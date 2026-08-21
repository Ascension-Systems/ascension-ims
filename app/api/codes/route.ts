import { NextResponse } from 'next/server'
import { randomInt } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST -> create (and optionally rotate to) a REP enrollment code. Admin only.
 *
 * ROLE IS FORCED TO 'rep' HERE, never read from the body. Admin codes are minted only by the
 * operator via SQL (migration 0016), so this endpoint can never become an admin-minting vector
 * even though the caller is an admin. A rep who reached this is refused by requireAdmin AND by
 * the `enrollment_codes_admin_all` RLS policy underneath.
 *
 * Writes through the COOKIE-BOUND client so RLS is the real gate. `rotate` deactivates the other
 * active rep codes first, so "change the code" leaves exactly one live rep code. Deactivating a
 * code never affects anyone already enrolled.
 */

const CODE_SHAPE = /^[A-Z0-9-]{8,64}$/
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no ambiguous 0/O/1/I/L

function generateCode(): string {
  let s = ''
  for (let i = 0; i < 8; i += 1) s += ALPHABET[randomInt(ALPHABET.length)]
  return `REP-${s}`
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

  const rl = checkRateLimit('codes:post', admin.profile.id, 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }
  const { code, rotate } = (body ?? {}) as { code?: unknown; rotate?: unknown }

  // A custom code is normalised to upper case and shape-checked; otherwise generate one.
  let newCode: string
  if (typeof code === 'string' && code.trim()) {
    newCode = code.trim().toUpperCase()
    if (!CODE_SHAPE.test(newCode)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Codes are 8–64 characters: letters, numbers and dashes.' },
        { status: 400 },
      )
    }
  } else {
    newCode = generateCode()
  }

  const supabase = await createClient()

  // Rotate: retire the other live rep codes first. Scoped to role='rep' so the admin code is
  // never touched here. RLS still requires is_admin() for the update to affect any row.
  if (rotate === true) {
    const { error: deErr } = await supabase
      .from('enrollment_codes')
      .update({ is_active: false })
      .eq('role', 'rep')
      .eq('is_active', true)
    if (deErr) {
      console.error('[api/codes] deactivate failed:', deErr.code, deErr.message)
      return NextResponse.json({ error: 'ROTATE_FAILED', message: 'Could not rotate the code.' }, { status: 500 })
    }
  }

  const { error } = await supabase.from('enrollment_codes').insert({
    code: newCode,
    label: 'Rep onboarding',
    role: 'rep', // forced — never from the body
    max_uses: 500,
    expires_at: new Date(Date.now() + 180 * 864e5).toISOString(),
    created_by: admin.profile.id,
  })

  if (error) {
    // A duplicate code is the one client-fixable case.
    const dup = error.code === '23505'
    if (!dup) console.error('[api/codes] insert failed:', error.code, error.message)
    return NextResponse.json(
      {
        error: dup ? 'DUPLICATE' : 'INSERT_FAILED',
        message: dup ? 'That code already exists. Choose another.' : 'Could not create the code.',
      },
      { status: dup ? 409 : 500 },
    )
  }

  return NextResponse.json({ ok: true, code: newCode }, { status: 201 })
}
