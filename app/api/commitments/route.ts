import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { mapPostgresError, parseInsufficientAvailability } from '@/lib/errors'

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
