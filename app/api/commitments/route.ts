import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/auth'
import { mapPostgresError, parseInsufficientAvailability } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST -> record_commitment RPC.
 *
 * REACHED BY THE UI as of build-order step 2: components/commit-form.tsx POSTs here from the
 * expanded product card. It is ALSO the server-side attack surface for the two ledger-related
 * verification requirements, which the brief requires be run "by querying directly rather than
 * through the UI" -- both callers hit the same handler, so the attacks exercise the real path.
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
  // IDENTITY AND BUDGET FIRST, BODY SECOND. Parsing first meant an unbounded payload was
  // fully deserialised for a caller who had not been identified and whose rate-limit budget
  // was already spent — a measurable latency cost from a single authenticated session.
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

  // Keyed on the revalidated user id, not on an IP header.
  const rl = checkRateLimit('commitments:post', user.id, 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
    )
  }

  // Reject an oversized body before any parsing at all.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 65_536) {
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

  const { sku, qty, location, note } = (body ?? {}) as {
    sku?: unknown
    qty?: unknown
    location?: unknown
    note?: unknown
  }

  if (typeof sku !== 'string' || sku.length === 0) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'A sku is required.' }, { status: 400 })
  }
  // Upper bound matters: postgres int4 overflows above 2147483647 and the database's clean
  // SQLSTATE 22003 was being downgraded to a 500 on the way out.
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'qty must be a whole number between 1 and 1,000,000.' },
      { status: 400 },
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
      // STATE THE FACT, NEVER INVENT A CAUSE. KY001 means "not enough available" -- it does
      // NOT mean another rep took it. Availability can be short simply because the source
      // figure is lower than the request. Asserting contention unconditionally produced a
      // message that contradicted the card two lines above it ("Committed by reps: 0").
      return NextResponse.json(
        {
          error: 'INSUFFICIENT_AVAILABILITY',
          message: `Only ${available} available.`,
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
