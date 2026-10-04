import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { notifyAdmins, pushConfigured, LOW_STOCK_DEFAULT } from '@/lib/push'

/** Constant-time secret compare over fixed-length digests (no length or short-circuit oracle). */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * POST -> the morning digest to admins: everything low on stock, one notification. Fired by the scheduled Netlify function (netlify/functions/
 * daily-digest.mjs), authenticated by the PUSH_CRON_SECRET header — no session, no cookies,
 * so the guard is a shared secret the same way a webhook would be.
 *
 * THIS IS ALSO THE SAFETY NET FOR THE SIMULATED LIVE FEED: pg_cron (0018) moves quantities
 * inside the database, below our API hooks, so a drift-induced low-stock line pushes nothing
 * at the moment it happens. The digest reads the current truth from v_inventory daily, so
 * nothing stays silently low for more than a day.
 */
export async function POST(request: Request) {
  const secret = process.env.PUSH_CRON_SECRET
  if (!secret || !secretMatches(request.headers.get('x-cron-secret'), secret)) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Bad or missing cron secret.' }, { status: 403 })
  }
  if (!pushConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'push not configured' }, { status: 200 })
  }

  const admin = createAdminClient()
  const { data: inv } = await admin
    .from('v_inventory')
    .select('sku, name, qty_available, low_stock_threshold')
    .order('qty_available', { ascending: true })
    .limit(500)

  // Per-product thresholds: PostgREST cannot compare two columns to each other, so the
  // low filter runs here. The catalogue is small (~100 lines); reading it whole is fine.
  const lowLines = (inv ?? []).filter((l) => l.qty_available <= (l.low_stock_threshold ?? LOW_STOCK_DEFAULT))
  const parts: string[] = []
  if (lowLines.length === 0) {
    parts.push('Nothing low on stock.')
  } else {
    const named = lowLines.slice(0, 3).map((l) => `${l.name ?? l.sku} (${l.qty_available})`)
    parts.push(
      `${lowLines.length} line${lowLines.length === 1 ? '' : 's'} low: ${named.join(', ')}${lowLines.length > 3 ? '…' : ''}`,
    )
  }

  await notifyAdmins({ title: 'Daily inventory digest', body: parts.join(' '), url: '/inventory' })
  return NextResponse.json({ ok: true, low: lowLines.length }, { status: 200 })
}
