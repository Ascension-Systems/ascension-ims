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

/**
 * `windowStartMs` fixes the window boundary and must NOT move while a window is open — moving it
 * would turn the fixed window into a sliding one and let a steady caller exceed the limit.
 * `lastSeenMs` is separate and exists only for eviction ordering. Do not merge them.
 */
type Window = { count: number; windowStartMs: number; lastSeenMs: number }

/**
 * ONE MAP PER BUCKET, NOT ONE MAP FOR EVERYTHING. THIS IS A SECURITY PROPERTY, NOT TIDINESS.
 *
 * State was previously a single flat `Map` keyed `${bucket}:${key}`, with overflow handled by
 * `windows.clear()`. That coupled every limiter in the process to every other one, and the
 * buckets do not have comparable key cardinality:
 *
 *   (an authenticated   keyed on a revalidated user.id  -> ~120 keys, bounded by the user list;
 *    per-user bucket)     the original one, commitments:post, was removed with 0025)
 *   health:auth           keyed on clientIpKey()          -> UNBOUNDED; the header is spoofable
 *   health:auth:global    a single constant key           -> exactly 1 key
 *
 * So an unauthenticated caller rotating `x-forwarded-for` against the public `/api/health/auth`
 * could mint unlimited `health:auth` keys, overflow the shared map, and reset the counters of
 * the other two buckets as collateral — flushing every signed-in user's per-user
 * budget AND the global probe ceiling that exists to bound outbound vendor traffic. A public,
 * unauthenticated endpoint must not be able to erase an authenticated endpoint's limiter, and
 * a limiter must not be able to erase its own backstop.
 *
 * Per-bucket maps make that structurally impossible: eviction is scoped to the bucket that
 * overflowed. The unbounded bucket churns within its own cap and touches nothing else, while
 * the two low-cardinality buckets never reach their cap and are therefore never evicted at all.
 *
 * Bucket names are string literals at the call sites, so the number of buckets is fixed at
 * author time and cannot be grown by a request.
 */
const buckets = new Map<string, Map<string, Window>>()

/**
 * Per-bucket cap, bounded without a timer. A `setInterval` in a serverless function keeps the
 * instance alive and leaks; eviction is therefore amortised onto the calls themselves.
 */
const MAX_ENTRIES_PER_BUCKET = 5000

/** How long a window must be untouched before it counts as dead. */
const DEAD_AFTER_MS = 10 * 60_000

/**
 * THE LOW-WATER MARK. EVICTION GOES DOWN TO HERE, NOT DOWN TO THE CAP. THIS IS A DoS CONTROL.
 *
 * Evicting back to exactly `MAX_ENTRIES_PER_BUCKET` removes ONE entry per admission, so a
 * bucket held at the cap runs the O(n log n) sort below on EVERY subsequent call. Measured on
 * this machine against this file: 0.11 microseconds per call with the bucket under its cap,
 * 268 microseconds per call with it held at the cap — a ~2,500x CPU amplification that an
 * unauthenticated caller triggers simply by rotating `x-forwarded-for` against the public
 * `/api/health/auth` until the `health:auth` bucket fills. The request is cheap for them and
 * expensive for us, which is the wrong way round, and on metered serverless it is a cost
 * amplifier as well as a latency one.
 *
 * Evicting down to 90% instead means the sort runs once per ~500 admissions rather than once
 * per admission, which is the same work amortised over 500x more calls. Nothing else changes:
 * the bucket is still hard-bounded (it can never exceed the cap by more than the single entry
 * added after the check), eviction is still least-recently-used, and buckets are still
 * isolated from one another.
 *
 * The security property that must survive this is the LRU ordering, not the batch size: a
 * larger batch discards more of the flood's single-use keys per sort, and an actively-used
 * counter still has the highest `lastSeenMs` in its bucket and is still the last thing
 * discarded. Assertion A6 in the audit harness holds that.
 */
const EVICT_DOWN_TO = Math.floor(MAX_ENTRIES_PER_BUCKET * 0.9)

function evictIfLarge(windows: Map<string, Window>, now: number): void {
  if (windows.size <= MAX_ENTRIES_PER_BUCKET) return

  for (const [key, w] of windows) {
    // An entry untouched for longer than the longest window in use is dead. 60s is the only
    // window this codebase uses; the generous multiple keeps this correct if a longer one is
    // added later without anyone remembering to update this line.
    if (now - w.lastSeenMs >= DEAD_AFTER_MS) windows.delete(key)
  }
  if (windows.size <= MAX_ENTRIES_PER_BUCKET) return

  // Still over. Evict LEAST-RECENTLY-USED, never `clear()`.
  //
  // Least-recently-USED, not oldest-window-START: those are different, and the difference is
  // the attack. A counter that is being actively hammered keeps the same `windowStartMs` for
  // the whole window, so sorting on window start would evict exactly the busiest, most
  // security-relevant counters first and hand a flooder a free reset. `lastSeenMs` is bumped
  // on every hit, so an actively-used counter is the LAST thing discarded and a flood of
  // single-use spoofed keys is the first.
  // Down to EVICT_DOWN_TO, not to the cap — see the note on that constant. Stopping at the cap
  // makes this sort run on every subsequent call.
  const byIdle = [...windows.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)
  for (const [key] of byIdle) {
    if (windows.size <= EVICT_DOWN_TO) break
    windows.delete(key)
  }
}

/**
 * Fixed-window counter. Returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`.
 *
 * `bucket` namespaces the key so two routes limiting on the same value (an IP, a user id) can
 * never share a counter — and, per the note above, so that one bucket's key churn can never
 * evict another bucket's state.
 */
export function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitVerdict {
  const now = Date.now()

  let windows = buckets.get(bucket)
  if (!windows) {
    windows = new Map<string, Window>()
    buckets.set(bucket, windows)
  }
  evictIfLarge(windows, now)

  const existing = windows.get(key)

  if (!existing || now - existing.windowStartMs >= windowMs) {
    windows.set(key, { count: 1, windowStartMs: now, lastSeenMs: now })
    return { allowed: true }
  }

  existing.count += 1
  existing.lastSeenMs = now
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
