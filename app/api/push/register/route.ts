import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

const MAX_DEVICES_PER_USER = 10

/**
 * POST -> register this device's APNs token for the signed-in user; DELETE -> remove it.
 *
 * Called by components/push-register.tsx on every app start (tokens rotate at Apple's whim,
 * so registration is an idempotent upsert, not a one-time event) and on sign-out. Identity is
 * the session cookie; the RLS policies on push_tokens (0020) hold user_id = auth.uid(), so a
 * caller cannot register a token against anyone else even by editing the request.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
  }

  const rl = checkRateLimit('push:register', user.id, 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'Too many requests.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }
  const { token, platform } = (body ?? {}) as { token?: unknown; platform?: unknown }

  // APNs device tokens are hex; length varies by device generation. Bound, don't overfit.
  if (typeof token !== 'string' || !/^[0-9a-fA-F]{16,512}$/.test(token)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'A device token is required.' }, { status: 400 })
  }
  const plat = platform === 'android' || platform === 'web' ? platform : 'ios'

  const { error } = await supabase
    .from('push_tokens')
    .upsert({ token, user_id: user.id, platform: plat, updated_at: new Date().toISOString() })
  if (error) {
    console.error('[push/register] upsert failed:', error.code, error.message)
    return NextResponse.json({ error: 'SERVER_ERROR', message: 'Could not register the device.' }, { status: 500 })
  }

  // Cap devices per user: a real person has a handful, and this bounds a hostile client that
  // would otherwise bank thousands of junk tokens to amplify every later fan-out. Keep the most
  // recently seen; own-rows only, so RLS is satisfied. Best-effort — never fails the register.
  try {
    const { data: mine } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
    if (mine && mine.length > MAX_DEVICES_PER_USER) {
      const excess = mine.slice(MAX_DEVICES_PER_USER).map((r) => r.token)
      await supabase.from('push_tokens').delete().in('token', excess)
    }
  } catch (e) {
    console.error('[push/register] device-cap prune failed:', e)
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const { token } = (body ?? {}) as { token?: unknown }
  const del = supabase.from('push_tokens').delete().eq('user_id', user.id)
  const { error } = typeof token === 'string' ? await del.eq('token', token) : await del
  if (error) {
    console.error('[push/register] delete failed:', error.code, error.message)
    return NextResponse.json({ error: 'SERVER_ERROR', message: 'Could not remove the device.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 200 })
}
