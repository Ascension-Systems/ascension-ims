import 'server-only'

import { createPrivateKey, sign } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { CommitmentState } from '@/lib/types'

/**
 * Direct APNs push — no Firebase, no third-party sender. The whole pipeline is:
 * an event in one of our own API routes calls a helper below, the helper reads device tokens
 * from push_tokens (service role), signs an ES256 JWT with the team's APNs auth key, and POSTs
 * one request per device to Apple. ~120 users at most, chunked; no queue needed at this scale.
 *
 * FAIL-SILENT BY DESIGN. Notifications are a courtesy layered on top of actions that must
 * succeed on their own: a commitment is not less recorded because a push failed. Every public
 * helper catches everything and logs; nothing here can ever fail a request. When the APNS_*
 * env vars are unset (local dev, or before the key is configured) every helper is a no-op.
 *
 * THE .p8 KEY IS AN ENV VAR (APNS_PRIVATE_KEY), server-side only, set in the Netlify dashboard
 * — the same handling as SUPABASE_SERVICE_ROLE_KEY. It is never committed and never NEXT_PUBLIC_.
 *
 * SANDBOX FALLBACK: a debug build from Xcode registers a *sandbox* device token, which the
 * production APNs host rejects as BadDeviceToken. On that specific refusal we retry once
 * against the sandbox host, so pushes work for dev builds and TestFlight/App Store builds
 * alike without configuration. Dead tokens (Unregistered/410) are deleted on sight.
 */

const PROD_HOST = 'https://api.push.apple.com'
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com'
const CONCURRENCY = 32 // in-flight APNs requests at once (worker-pool width)
const JWT_TTL_MS = 45 * 60 * 1000 // Apple allows 20–60 min; refresh comfortably inside that

export type PushNote = {
  title: string
  body: string
  /** In-app path to open when the notification is tapped, e.g. '/inventory'. */
  url?: string
}

function env(name: string): string | null {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

export function pushConfigured(): boolean {
  return !!(env('APNS_TEAM_ID') && env('APNS_KEY_ID') && env('APNS_PRIVATE_KEY') && env('APNS_BUNDLE_ID'))
}

// --- ES256 provider JWT, cached and refreshed inside Apple's accepted window. ---
let cachedJwt: { token: string; at: number } | null = null

/** Drop the cached JWT so the next send mints a fresh one — called when Apple rejects the token. */
function invalidateJwt(): void {
  cachedJwt = null
}

function providerJwt(): string {
  if (cachedJwt && Date.now() - cachedJwt.at < JWT_TTL_MS) return cachedJwt.token
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'ES256', kid: env('APNS_KEY_ID') })
  const claims = b64({ iss: env('APNS_TEAM_ID'), iat: Math.floor(Date.now() / 1000) })
  const unsigned = `${head}.${claims}`
  // The .p8 arrives with literal \n if pasted into a single-line env field; restore them.
  const pem = (env('APNS_PRIVATE_KEY') as string).replace(/\\n/g, '\n')
  const key = createPrivateKey(pem)
  // JWT ES256 wants the raw r||s form, not DER — hence ieee-p1363.
  const sig = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const token = `${unsigned}.${sig}`
  cachedJwt = { token, at: Date.now() }
  return token
}

async function sendOne(deviceToken: string, note: PushNote, host: string): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${providerJwt()}`,
      'apns-topic': env('APNS_BUNDLE_ID') as string,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    },
    body: JSON.stringify({
      aps: { alert: { title: note.title, body: note.body }, sound: 'default' },
      url: note.url ?? '/',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.ok) return { ok: true }
  const body = (await res.json().catch(() => ({}))) as { reason?: string }
  return { ok: false, reason: body.reason ?? `HTTP ${res.status}` }
}

/**
 * Send one note to a set of raw device tokens. Returns tokens APNs declared dead.
 *
 * A bounded worker pool sends up to CONCURRENCY devices at once rather than in strictly serial
 * chunks — the old serial-chunk loop meant a 120-device broadcast with a hung APNs could take
 * 6 × 10s = 60s. With the pool, worst case is ~one timeout window even for the whole fleet, and
 * combined with off-request-path delivery (callers use `after()`) it never blocks a response.
 */
async function fanOut(tokens: string[], note: PushNote): Promise<string[]> {
  const dead: string[] = []
  let i = 0
  const worker = async () => {
    while (i < tokens.length) {
      const t = tokens[i++]
      try {
        let r = await sendOne(t, note, PROD_HOST)
        // A dev build's token is a sandbox token; production says BadDeviceToken. Retry there.
        if (!r.ok && r.reason === 'BadDeviceToken') r = await sendOne(t, note, SANDBOX_HOST)
        if (!r.ok && (r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'ExpiredToken')) {
          dead.push(t)
        } else if (!r.ok) {
          // A rejected provider token means our cached JWT is bad — drop it so the next
          // send re-signs instead of repeating the failure for up to 45 minutes.
          if (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken') invalidateJwt()
          console.error('[push] APNs refused:', r.reason)
        }
      } catch (e) {
        // Surface what the fail-silent design would otherwise bury: a thrown sendOne (bad key,
        // network, timeout). Logged, never rethrown — one dead device can't stop the fan-out.
        console.error('[push] send threw:', e instanceof Error ? e.message : e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tokens.length) }, worker))
  return dead
}

/** The one internal entry point: resolve users -> tokens, send, prune dead tokens. */
async function pushToUserIds(userIds: string[], note: PushNote): Promise<void> {
  if (!pushConfigured() || userIds.length === 0) return
  const admin = createAdminClient()
  const { data: rows, error } = await admin
    .from('push_tokens')
    .select('token')
    .in('user_id', userIds)
  if (error || !rows?.length) return
  const dead = await fanOut(rows.map((r) => r.token), note)
  if (dead.length) await admin.from('push_tokens').delete().in('token', dead)
}

// ---------------------------------------------------------------------------
// Public helpers. ALL of them are fire-safe: catch everything, log, never throw.
// ---------------------------------------------------------------------------

export async function notifyUsers(userIds: string[], note: PushNote): Promise<void> {
  try {
    await pushToUserIds(userIds, note)
  } catch (e) {
    console.error('[push] notifyUsers failed:', e)
  }
}

export async function notifyAdmins(note: PushNote, excludeUserId?: string): Promise<void> {
  try {
    if (!pushConfigured()) return
    const admin = createAdminClient()
    const { data } = await admin.from('profiles').select('id').eq('role', 'admin')
    const ids = (data ?? []).map((p) => p.id).filter((id) => id !== excludeUserId)
    await pushToUserIds(ids, note)
  } catch (e) {
    console.error('[push] notifyAdmins failed:', e)
  }
}

export async function notifyEveryone(note: PushNote, excludeUserId?: string): Promise<void> {
  try {
    if (!pushConfigured()) return
    const admin = createAdminClient()
    const { data } = await admin.from('profiles').select('id')
    const ids = (data ?? []).map((p) => p.id).filter((id) => id !== excludeUserId)
    await pushToUserIds(ids, note)
  } catch (e) {
    console.error('[push] notifyEveryone failed:', e)
  }
}

/** Reps with a live (pending/confirmed) commitment on this sku — the people a change affects. */
export async function notifyRepsCommittedTo(sku: string, note: PushNote, excludeUserId?: string): Promise<void> {
  try {
    if (!pushConfigured()) return
    const admin = createAdminClient()
    // 'confirmed_in_source' is the real enum label (migration 0001) — NOT 'confirmed'. An
    // invalid token poisons the whole IN list (22P02), so getting this wrong silently notifies
    // nobody. Errors are logged, never swallowed, so a poisoned query can't hide again.
    const LIVE_STATES: CommitmentState[] = ['pending', 'confirmed_in_source']
    const { data, error } = await admin
      .from('commitments')
      .select('rep_id')
      .eq('sku', sku)
      .in('state', LIVE_STATES)
    if (error) {
      console.error('[push] notifyRepsCommittedTo query failed:', error.code, error.message)
      return
    }
    const ids = [...new Set((data ?? []).map((c) => c.rep_id))].filter((id) => id !== excludeUserId)
    await pushToUserIds(ids, note)
  } catch (e) {
    console.error('[push] notifyRepsCommittedTo failed:', e)
  }
}

/**
 * Low-stock check against v_inventory's qty_available — the same conservative figure the UI
 * badges from — using each product's own low_stock_threshold (with the env default as the
 * fallback). Called after anything that moves stock; repeat alerts for the same line are
 * throttled to one per hour per server instance.
 */
// Guard against a garbage env value: an un-parseable threshold as NaN would make `qty > NaN`
// false everywhere (alert on every SKU) AND `qty <= NaN` false everywhere (digest reports none).
const _lowEnv = Number(process.env.PUSH_LOW_STOCK_THRESHOLD)
export const LOW_STOCK_DEFAULT = Number.isFinite(_lowEnv) ? _lowEnv : 5
const lowStockLastSent = new Map<string, number>()

export async function checkLowStock(sku: string, location: string): Promise<void> {
  try {
    if (!pushConfigured()) return
    const admin = createAdminClient()
    const { data } = await admin
      .from('v_inventory')
      .select('sku, location, name, qty_available, low_stock_threshold')
      .eq('sku', sku)
      .eq('location', location)
      .maybeSingle()
    if (!data || data.qty_available > (data.low_stock_threshold ?? LOW_STOCK_DEFAULT)) return
    const key = `${sku}@${location}`
    const last = lowStockLastSent.get(key) ?? 0
    if (Date.now() - last < 60 * 60 * 1000) return
    lowStockLastSent.set(key, Date.now())
    await notifyAdmins({
      title: 'Low stock',
      body: `${data.name ?? sku}: ${data.qty_available} available.`,
      url: '/inventory',
    })
  } catch (e) {
    console.error('[push] checkLowStock failed:', e)
  }
}
