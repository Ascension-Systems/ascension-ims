import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { mapPostgresError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rate-limit'
import { notifyEveryone, checkLowStock } from '@/lib/push'

/**
 * PATCH -> an ADMIN OVERRIDE of an inventory row. Build-order step 3.
 *
 * This is both the interim data source (QuickBooks is stubbed, so nothing else writes real
 * quantities) and the PERMANENT correction layer for when the source is wrong. The brief's
 * open question 1 is explicit: if staff hand-correct numbers QuickBooks gets wrong, those
 * corrections ARE the real data, so this layer is not scaffolding awaiting an integration.
 *
 * AN OVERRIDE IS ALWAYS ATTRIBUTED. The database constraint `inventory_override_is_attributed`
 * (migration 0004) requires override_note and override_at to be NOT NULL whenever source is
 * 'manual_override', so a correction can never be anonymous or undated. This handler supplies
 * all three together; a note is therefore REQUIRED, not optional. That is deliberate — an
 * unexplained hand-correction to a number reps quote customers from is exactly the kind of
 * silent override the show-both-numbers design exists to prevent.
 *
 * TWO LAYERS OF ROLE ENFORCEMENT, database authoritative:
 *   1. requireAdmin() here, so a rep gets a clean 403 rather than a confusing 0-row success.
 *   2. RLS policy `inventory_update_admin` (migration 0011), `USING (public.is_admin())`.
 * Layer 2 is the real gate: attack 4 proves a rep's identical UPDATE affects 0 rows and leaves
 * the row unchanged, with an admin control proving the same statement succeeds. Hiding the
 * form is not access control and neither is this handler.
 *
 * qty_committed IS NOT WRITABLE HERE. It is QuickBooks' figure (open sales orders) and the
 * only source of committed since 0025; the database refuses the column for INSERT and UPDATE.
 */
export async function PATCH(request: Request) {
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

  // Keyed on the admin's own id, after identity is known and before the database is touched.
  const rl = checkRateLimit('inventory:patch', admin.profile.id, 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
    )
  }

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
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'Expected a JSON body.' },
      { status: 400 },
    )
  }

  const { sku, location, qty_on_hand, qty_incoming, note } = (body ?? {}) as {
    sku?: unknown
    location?: unknown
    qty_on_hand?: unknown
    qty_incoming?: unknown
    note?: unknown
  }

  if (typeof sku !== 'string' || sku.length === 0) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'A sku is required.' }, { status: 400 })
  }
  if (typeof qty_on_hand !== 'number' || !Number.isInteger(qty_on_hand) || qty_on_hand < 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'qty_on_hand must be a whole number, zero or more.' },
      { status: 400 },
    )
  }
  if (
    qty_incoming !== undefined &&
    (typeof qty_incoming !== 'number' || !Number.isInteger(qty_incoming) || qty_incoming < 0)
  ) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'qty_incoming must be a whole number, zero or more.' },
      { status: 400 },
    )
  }
  // Required, and bounded. The constraint needs it non-null; the cap keeps an unbounded string
  // out of a table reps read from.
  if (typeof note !== 'string' || note.trim().length === 0) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'A reason for the correction is required.' },
      { status: 400 },
    )
  }
  if (note.length > 280) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'Keep the reason under 280 characters.' },
      { status: 400 },
    )
  }

  const supabase = await createClient()
  const loc = typeof location === 'string' && location ? location : 'default'

  // Read the prior figure FIRST, solely to detect a 0 -> >0 transition for the back-in-stock
  // notification below. Advisory only: the update itself never branches on this value.
  const { data: prior } = await supabase
    .from('inventory')
    .select('qty_on_hand')
    .eq('sku', sku)
    .eq('location', loc)
    .maybeSingle()

  const patch: Record<string, unknown> = {
    qty_on_hand,
    source: 'manual_override',
    override_note: note.trim(),
    override_at: new Date().toISOString(),
    override_by: admin.profile.id,
    updated_at: new Date().toISOString(),
  }
  if (typeof qty_incoming === 'number') patch.qty_incoming = qty_incoming

  const { data, error } = await supabase
    .from('inventory')
    .update(patch)
    .eq('sku', sku)
    .eq('location', loc)
    .select()

  if (error) {
    const mapped = mapPostgresError(error)
    if (mapped.status === 500) {
      console.error('[api/inventory] unmapped database error:', error.code, error.message)
    }
    return NextResponse.json({ error: mapped.error, message: mapped.message }, { status: mapped.status })
  }

  // RLS filters an UPDATE rather than raising, so zero rows means "no such row, or policy
  // refused it" — never a silent success. Reported honestly rather than as a 200.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'No inventory row matched, or the update was refused.' },
      { status: 404 },
    )
  }

  // Notifications, all fail-silent, all via after() so a broadcast fan-out (back-in-stock can
  // reach every rep) runs AFTER the 200 and never delays or times out the admin's correction:
  //   * back in stock (0 -> >0): every rep hears — that's sellable news for the whole floor.
  //   * any other correction: no targeted push. (Until 0025 this went to reps holding portal
  //     commitments on the sku; the portal no longer records commitments.)
  //   * low-stock check: the correction may itself have dropped the line under the threshold.
  after(async () => {
    if (prior && prior.qty_on_hand === 0 && qty_on_hand > 0) {
      await notifyEveryone(
        { title: 'Back in stock', body: `${sku}: ${qty_on_hand} on hand.`, url: '/inventory' },
        admin.profile.id,
      )
    }
    await checkLowStock(sku, loc)
  })

  return NextResponse.json({ inventory: data[0] }, { status: 200 })
}
