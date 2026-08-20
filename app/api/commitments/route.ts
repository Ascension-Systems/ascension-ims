import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/auth'
import { mapPostgresError, parseInsufficientAvailability } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST -> record_commitment RPC.
 *
 * NO UI POINTS AT THIS. Build-order step 2 (the rep commitment-recording screen) is approved
 * in principle but HELD (D8). There is no button, form, screen, link or placeholder anywhere
 * in this run that reaches this route. It exists because the commitments DATA LAYER ships in
 * full so the two ledger-related verification requirements are attackable server-side --
 * which is exactly how the brief says those attacks are run, "by querying directly rather
 * than through the UI".
 *
 * Identity is NOT taken from the request. record_commitment has no rep_id parameter: it reads
 * auth.uid() inside the function, which is what stops a SECURITY DEFINER function from
 * becoming an RLS bypass. This handler cannot record a commitment on another rep's behalf
 * even if it wanted to.
 *
 * Branching is on the SQLSTATE (PostgrestError.code), NEVER on message text.
 *
 * ------------------------------------------------------------------------------------
 * SCOPE: A PROVISIONED IDENTITY, NOT `admin`. THE DATABASE IS THE REAL GATE AND THIS DOES
 * NOT CONTRADICT IT.
 * ------------------------------------------------------------------------------------
 * `record_commitment` (migration 0009) raises KY002 on a NULL auth.uid(): it requires AN
 * AUTHENTICATED IDENTITY, not a specific role, and takes no p_rep_id. Migration 0012 grants
 * EXECUTE to `authenticated, service_role`. Migration 0011's single commitments policy is
 * `rep_id = auth.uid() OR is_admin()`.
 *
 * REQUIRING `admin` HERE WOULD CONTRADICT THE DATABASE — the gate that actually matters — and
 * would make this route unusable as the rep-attack surface for verification requirements 2 and
 * 3 (verify/hosted/lib/app-probe.mjs POSTs it with a REP session and expects 409). So the
 * predicate is the narrowest scope the DB permits without contradicting it: a valid session
 * AND a `public.profiles` row whose `role` is in the `app_role` enum. `app_role` has exactly
 * two values, so this check is "is this a provisioned account".
 *
 * ------------------------------------------------------------------------------------
 * RATE LIMITED, AND HONEST ABOUT WHAT THAT MEANS.
 * ------------------------------------------------------------------------------------
 * 30 requests/minute per user, keyed on `user.id` from a revalidated getUser() session —
 * unforgeable, and better than IP for an authenticated route. See the limitation note in
 * `lib/rate-limit.ts`: this is PER-INSTANCE friction on Netlify, not a global guarantee. The
 * database is still the real gate.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }

  const { sku, qty, location, note } = (body ?? {}) as {
    sku?: unknown
    qty?: unknown
    location?: unknown
    note?: unknown
  }

  if (typeof sku !== 'string' || sku.length === 0) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'A sku is required.' }, { status: 400 })
  }
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'qty must be a positive integer.' },
      { status: 400 },
    )
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
  }

  // A session alone is not enough: the account must be PROVISIONED. getProfile() is the
  // existing helper in lib/auth.ts; no new one is introduced.
  const profile = await getProfile()
  if (!profile || (profile.role !== 'rep' && profile.role !== 'admin')) {
    return NextResponse.json(
      { error: 'FORBIDDEN_ROLE', message: 'This account is not provisioned for the portal.' },
      { status: 403 },
    )
  }

  // Keyed on the revalidated user id, not on an IP header. Checked after the identity is known
  // and before the database is touched.
  const rl = checkRateLimit('commitments:post', user.id, 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
    )
  }

  const { data, error } = await supabase.rpc('record_commitment', {
    p_sku: sku,
    p_qty: qty,
    p_location: typeof location === 'string' && location ? location : 'default',
    p_note: typeof note === 'string' ? note : null,
  })

  if (error) {
    const mapped = mapPostgresError(error)

    if (error.code === 'KY001') {
      const parsed = parseInsufficientAvailability(error.message)
      const available = parsed?.available ?? 0
      return NextResponse.json(
        {
          error: 'INSUFFICIENT_AVAILABILITY',
          message: `Only ${available} available — another rep committed the last unit first.`,
          sku,
          location: typeof location === 'string' && location ? location : 'default',
          requested: parsed?.requested ?? qty,
          available,
        },
        { status: 409 },
      )
    }

    if (mapped.status === 500) {
      // Details are logged server-side and never returned.
      console.error('[api/commitments] unmapped database error:', error.code, error.message)
    }

    return NextResponse.json({ error: mapped.error, message: mapped.message }, { status: mapped.status })
  }

  return NextResponse.json({ commitment: data }, { status: 201 })
}
