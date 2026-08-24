import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { notifyAdmins, pushConfigured } from '@/lib/push'

/**
 * POST -> the morning digest to admins: everything low on stock plus yesterday's commitment
 * count, one notification. Fired by the scheduled Netlify function (netlify/functions/
 * daily-digest.mjs), authenticated by the PUSH_CRON_SECRET header — no session, no cookies,
 * so the guard is a shared secret the same way a webhook would be.
 *
 * THIS IS ALSO THE SAFETY NET FOR THE SIMULATED LIVE FEED: pg_cron (0018) moves quantities
 * inside the database, below our API hooks, so a drift-induced low-stock line pushes nothing
 * at the moment it happens. The digest reads the current truth from v_inventory daily, so
 * nothing stays silently low for more than a day.
 */
const LOW = Number(process.env.PUSH_LOW_STOCK_THRESHOLD ?? 5)

export async function POST(request: Request) {
  const secret = process.env.PUSH_CRON_SECRET
  if (!secret || request.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Bad or missing cron secret.' }, { status: 403 })
  }
  if (!pushConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'push not configured' }, { status: 200 })
  }

  const admin = createAdminClient()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [{ data: low }, { count: committed }] = await Promise.all([
    admin
      .from('v_inventory')
      .select('sku, product_name, qty_available')
      .lte('qty_available', LOW)
      .order('qty_available', { ascending: true })
      .limit(50),
    admin.from('commitments').select('id', { count: 'exact', head: true }).gte('created_at', since),
  ])

  const lowLines = low ?? []
  const parts: string[] = []
  parts.push(`${committed ?? 0} commitment${(committed ?? 0) === 1 ? '' : 's'} in the last day.`)
  if (lowLines.length === 0) {
    parts.push('Nothing low on stock.')
  } else {
    const named = lowLines.slice(0, 3).map((l) => `${l.product_name ?? l.sku} (${l.qty_available})`)
    parts.push(
      `${lowLines.length} line${lowLines.length === 1 ? '' : 's'} low: ${named.join(', ')}${lowLines.length > 3 ? '…' : ''}`,
    )
  }

  await notifyAdmins({ title: 'Daily inventory digest', body: parts.join(' '), url: '/inventory' })
  return NextResponse.json({ ok: true, low: lowLines.length, committed: committed ?? 0 }, { status: 200 })
}
