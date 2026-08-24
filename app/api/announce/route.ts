import { NextResponse, after } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { notifyEveryone, pushConfigured } from '@/lib/push'

/**
 * POST -> an admin broadcast to every registered device ("Team meeting 4pm", "New floor
 * pricing starts Monday"). Free text, so the guardrails are tight: admin only, short, plain
 * text, rate limited to a human cadence. This is the ONLY notification whose content is typed
 * rather than derived from a system event.
 */
export async function POST(request: Request) {
  const admin = await requireAdmin()
  if (!admin.ok) {
    const status = admin.reason === 'NOT_AUTHENTICATED' ? 401 : 403
    return NextResponse.json(
      { error: admin.reason, message: status === 401 ? 'Sign in to continue.' : 'This action requires an admin account.' },
      { status },
    )
  }

  const rl = checkRateLimit('announce:post', admin.profile.id, 5, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'Too many announcements. Wait a minute.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }
  const { message } = (body ?? {}) as { message?: unknown }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Write an announcement first.' }, { status: 400 })
  }
  if (message.length > 180) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'Keep it under 180 characters — it has to fit a lock screen.' },
      { status: 400 },
    )
  }

  if (!pushConfigured()) {
    return NextResponse.json(
      { error: 'PUSH_NOT_CONFIGURED', message: 'Push is not configured on the server yet (APNS_* variables).' },
      { status: 503 },
    )
  }

  // The sender hears their own announcement too — deliberate: it is the proof it went out.
  // after() so a fleet-wide fan-out (up to 120 devices) runs past the response instead of
  // risking the function timeout; the admin's own device still receives it moments later.
  after(() => notifyEveryone({ title: 'Announcement', body: message.trim(), url: '/inventory' }))
  return NextResponse.json({ ok: true }, { status: 200 })
}
