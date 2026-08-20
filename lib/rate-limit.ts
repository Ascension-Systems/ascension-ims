import 'server-only'

/**
 * One fixed-window rate limiter, shared by every route that needs one.
 *
 * ------------------------------------------------------------------------------------
 * THIS IS FRICTION, NOT A GUARANTEE — AND IT IS HONEST ABOUT BOTH HALVES.
 * ------------------------------------------------------------------------------------
 * (1) PER-INSTANCE. The Map below lives in one process. On Netlify each serverless instance
 *     has its own, and a cold start resets it, so the effective global limit is
 *     (instances x limit), not `limit`. A shared store — Redis/Upstash, or a Postgres table —
 *     is the step-2 answer. It is out of scope here and is not pretended otherwise. Do not
 *     read a limit below as a number the system enforces globally.
 *
 * (2) IP-KEYED LIMITING TRUSTS A REQUEST HEADER. `x-forwarded-for` is client-settable. That is
 *     acceptable ONLY because this is not a security boundary: the worst outcome is an attacker
 *     evading their own rate limit, which puts them in exactly the position they would be in if
 *     there were no limiter at all. NO AUTHORISATION DECISION ANYWHERE IN THIS CODEBASE READS
 *     THIS VALUE. Contrast `NEXT_PUBLIC_SITE_URL` in `lib/env.ts`, which deliberately does NOT
 *     come from a header, because that one IS a security decision — a header-derived origin
 *     there was a live account-takeover path.
 *
 * The authenticated route keys on `user.id` instead, taken from a revalidated `getUser()`
 * session, which is unforgeable. IP-keying is used only where there is no identity to key on.
 *
 * The database remains the real gate in every case. Nothing here is access control.
 */

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number }

type Window = { count: number; windowStartMs: number }

/**
 * Module-level, deliberately. It is process-scoped state and that is the whole limitation
 * documented above.
 */
const windows = new Map<string, Window>()

/**
 * Bounded without a timer. A `setInterval` in a serverless function keeps the instance alive
 * and leaks; eviction is therefore amortised onto the calls themselves.
 */
const MAX_ENTRIES = 5000

function evictIfLarge(now: number): void {
  if (windows.size <= MAX_ENTRIES) return
  for (const [key, w] of windows) {
    // An entry whose window is older than the longest window in use is dead. 60s is the only
    // window this codebase uses; the generous multiple keeps this correct if a longer one is
    // added later without anyone remembering to update this line.
    if (now - w.windowStartMs >= 10 * 60_000) windows.delete(key)
  }
  if (windows.size > MAX_ENTRIES) windows.clear()
}

/**
 * Fixed-window counter. Returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`.
 *
 * `bucket` namespaces the key so two routes limiting on the same value (an IP, a user id) can
 * never share a counter.
 */
export function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitVerdict {
  const now = Date.now()
  evictIfLarge(now)

  const mapKey = `${bucket}:${key}`
  const existing = windows.get(mapKey)

  if (!existing || now - existing.windowStartMs >= windowMs) {
    windows.set(mapKey, { count: 1, windowStartMs: now })
    return { allowed: true }
  }

  existing.count += 1
  if (existing.count <= limit) {
    return { allowed: true }
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((existing.windowStartMs + windowMs - now) / 1000),
  )
  return { allowed: false, retryAfterSeconds }
}

/**
 * The best available client identifier, in the order Netlify makes them available.
 *
 * Every caller whose IP cannot be derived shares the single bucket `'unknown'`. That limits
 * MORE, not less, which is the safe direction for a limiter: the failure mode is a shared
 * budget, never an unlimited one.
 */
export function clientIpKey(headers: Headers): string {
  const netlify = headers.get('x-nf-client-connection-ip')
  if (netlify && netlify.trim() !== '') return netlify.trim()

  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  return 'unknown'
}
