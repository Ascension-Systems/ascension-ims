import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { mapPostgresError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST -> bulk-add addresses to the enrollment allowlist. Admin only.
 *
 * The allowlist is what makes a widely-shared enrollment code safe: the code alone grants
 * nothing, because it must be paired with an address an admin already vouched for.
 *
 * Writes through the COOKIE-BOUND client, not service_role, so RLS decides. Policy
 * `invited_reps_admin_all` is `USING (public.is_admin())`, which means a rep's identical
 * request inserts zero rows -- the database is the gate, not this handler.
 */

const MAX_BATCH = 500
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  const rl = checkRateLimit('invites:post', admin.profile.id, 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
    )
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 131_072) {
    return NextResponse.json(
      { error: 'PAYLOAD_TOO_LARGE', message: 'That list is too large. Split it into batches.' },
      { status: 413 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }

  const { emails, role } = (body ?? {}) as { emails?: unknown; role?: unknown }
  if (typeof emails !== 'string' || emails.trim().length === 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'Paste at least one email address.' },
      { status: 400 },
    )
  }
  // Role of the invitation. Anything but the literal 'admin' is a rep, so a malformed value
  // can only ever UNDER-privilege. An admin choosing 'admin' here is intended: onboarding an
  // admin needs BOTH this invite AND the admin code (claim_enrollment enforces the match).
  const inviteRole: 'rep' | 'admin' = role === 'admin' ? 'admin' : 'rep'

  // Accept whatever shape a client's list arrives in: newlines, commas, semicolons, tabs.
  const raw = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  const valid = [...new Set(raw.filter((e) => e.length <= 254 && EMAIL.test(e)))]
  const invalid = [...new Set(raw.filter((e) => !EMAIL.test(e) || e.length > 254))]

  if (valid.length === 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'No valid email addresses found in that list.', invalid },
      { status: 400 },
    )
  }
  if (valid.length > MAX_BATCH) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: `Too many at once. Paste up to ${MAX_BATCH} per batch.` },
      { status: 400 },
    )
  }

  const supabase = await createClient()

  // ON CONFLICT DO NOTHING: re-pasting the same list is a NORMAL operator action, and it must
  // never reset an invitation someone has already claimed.
  const { data, error } = await supabase
    .from('invited_reps')
    .upsert(
      valid.map((email) => ({ email, invited_by: admin.profile.id, role: inviteRole })),
      { onConflict: 'email', ignoreDuplicates: true },
    )
    .select('email')

  if (error) {
    const mapped = mapPostgresError(error)
    if (mapped.status === 500) console.error('[api/invites] unmapped error:', error.code, error.message)
    return NextResponse.json({ error: mapped.error, message: mapped.message }, { status: mapped.status })
  }

  const added = data?.length ?? 0
  return NextResponse.json(
    {
      ok: true,
      added,
      alreadyInvited: valid.length - added,
      invalid,
    },
    { status: 200 },
  )
}
