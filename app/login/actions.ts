'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'
import {
  classifyAuthError,
  LOGIN_ERROR,
  UNCLASSIFIED_REASON,
  type AuthFailureClass,
} from './auth-error'

/**
 * Magic-link request. No password fields, no reset flow, no credential storage.
 *
 * shouldCreateUser: false is DELIBERATE. Users are pre-provisioned by the Human in the
 * Supabase dashboard. Left at the default, anyone on the internet with any email address
 * could self-register into a portal showing a client's inventory. (Plan decision A1;
 * README.md documents how the Human provisions a user and sets their role.)
 *
 * THE RESPONSE IS ALWAYS THE SAME, whether or not the address exists. Revealing which
 * addresses are registered is a user-enumeration leak, and with ~120 named external reps it
 * is a real one. Errors are logged server-side and the same success shape is returned.
 *
 * ------------------------------------------------------------------------------------
 * RATE LIMITING — an application limiter, not just Supabase's per-address throttle.
 * ------------------------------------------------------------------------------------
 * This endpoint is public and unauthenticated and makes one GoTrue signInWithOtp call per
 * request with a caller-chosen address. Left unprotected it can burn the project's auth quota
 * and get the deployment's egress IP throttled by Supabase — which breaks sign-in for all
 * ~120 reps at once. A per-IP limit ALONE does not close that: `clientIpKey` falls back to the
 * client-settable `x-forwarded-for`, so a caller rotating that header gets a fresh bucket every
 * request. So this mirrors `app/api/health/auth/route.ts` — the other endpoint whose real job
 * is protecting shared GoTrue — with TWO tiers: an honest per-IP limit for a well-behaved
 * caller, plus a global, IP-independent ceiling a spoofed header cannot escape. Both are cheap
 * load-shedding that runs BEFORE any GoTrue work, and the rejection is the ONLY response NOT
 * padded by the timing floor below (it is address-independent, so it leaks nothing). Per-instance
 * on Netlify (see lib/rate-limit.ts) — friction, not a global guarantee; the DB is the real gate.
 *
 * ------------------------------------------------------------------------------------
 * CONSTANT-TIME FLOOR — closes a timing-based enumeration channel.
 * ------------------------------------------------------------------------------------
 * A registered address triggers a synchronous mail send inside signInWithOtp (slow); an
 * unregistered one returns fast (user_not_found, SUPPRESSED). The response body is byte-for-byte
 * identical either way, but the RESPONSE TIME leaked registration for the ~120 named reps. Every
 * outcome that reaches the timed region — SUCCESS, SUPPRESSED, UNAVAILABLE, and the malformed-
 * address case — now returns no sooner than FLOOR_MS from the start of that region. signInWithOtp
 * is raced against a timeout at FLOOR_MS; a send that overruns is abandoned and classified
 * UNAVAILABLE, so even send-latency variance cannot reopen the channel — every path converges on
 * FLOOR_MS (+ jitter). Jitter is ON TOP of the floor, never instead of it (averaging defeats
 * jitter but not a floor). The malformed-address redirect is inside the floored region too, so a
 * bad format takes the same time as everything else.
 *
 * FLOOR_MS is a CONSERVATIVE DEFAULT, not a measured value: the hosted project uses Supabase's
 * built-in email, whose low per-address/hour cap made every latency probe return
 * `over_email_send_rate_limit` rather than a real send, so a p99 could not be measured (2026-08-20,
 * 0 clean samples of 13 attempts). 1500 ms comfortably exceeds any realistic GoTrue SMTP handshake
 * and the fast-reject path alike. If a custom SMTP is configured for production, re-measure and
 * tighten this: BASE = max(observed_max, 2×median); FLOOR_MS = roundUpTo250(BASE×1.5), min 1000.
 *
 * ------------------------------------------------------------------------------------
 * ERROR CLASSIFICATION — a silent failure was dressed as a security property.
 * ------------------------------------------------------------------------------------
 * This action used to log EVERY error class and redirect to /login/check-email regardless. With
 * a wrong or rotated anon key, or during a Supabase incident, all ~120 reps saw "check your
 * email", no email arrived, and the portal looked healthy. The suppression is real but only ever
 * applied to ADDRESS-SPECIFIC conditions. "This address is not registered" must not be disclosed;
 * "our auth provider is down" is not about the address and hiding it protects nobody. So the
 * error is classified (`./auth-error.ts`, which branches on `status`/`code`, NEVER on message
 * text) into three outcomes:
 *
 *   SUPPRESSED    address-specific -> the SAME /login/check-email page as success, byte for
 *                 byte, from the SAME redirect call site below. Server-side log only.
 *   RATE_LIMITED  -> /login?error=rate_limited.
 *   UNAVAILABLE   everything else, INCLUDING everything unrecognised -> /login?error=unavailable
 *
 * The default is UNAVAILABLE. An error shape nobody has seen yet fails honestly rather than being
 * reported as a sent email. That default is the fix; do not narrow it.
 *
 * ------------------------------------------------------------------------------------
 * THE REDIRECT ORIGIN IS CONFIGURATION, NOT A HEADER.
 * ------------------------------------------------------------------------------------
 * `emailRedirectTo` is NEXT_PUBLIC_SITE_URL via lib/env.ts, never x-forwarded-host. A forged host
 * on a login submitted for a VICTIM'S address would send them a magic link pointing at the
 * attacker's origin; clicking it hands over the auth `code` — account takeover. DO NOT reintroduce
 * a header fallback "for previews"; a preview deployment sets its own NEXT_PUBLIC_SITE_URL.
 */

// Conservative timing floor. See the CONSTANT-TIME FLOOR note above for why it is not measured.
const FLOOR_MS = 1500
// Jitter added ON TOP of the floor (defence in depth; the floor alone closes the channel).
const JITTER_MAX_MS = 150
// A well-behaved rep types an address, maybe mistypes once, maybe resends — 5/min absorbs that
// and stops a script. Magic-link login is infrequent (sessions are long-lived), so shared-NAT
// collisions are unlikely; raise with a stated reason if heavy shared egress is expected.
const IP_LIMIT = 5
// Global ceiling well above worst-case legitimate volume (even onboarding all ~120 reps is spread
// across instances and 60s windows) yet finite — this is what a spoofed x-forwarded-for cannot
// escape, and it is the actual quota protector.
const GLOBAL_LIMIT = 120
const RATE_WINDOW_MS = 60_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const TIMED_OUT = '__login_send_timed_out__' as const

export async function requestMagicLink(formData: FormData) {
  // --- Item 1: rate limit, BEFORE any GoTrue work, and NOT floored. -------------------------
  // Run both tiers (each increments its own counter), then reject if either denies. This
  // rejection is address-independent, so returning fast leaks nothing.
  const requestHeaders = await headers()
  const ipVerdict = checkRateLimit('login:request', clientIpKey(requestHeaders), IP_LIMIT, RATE_WINDOW_MS)
  const globalVerdict = checkRateLimit('login:request:global', 'all', GLOBAL_LIMIT, RATE_WINDOW_MS)
  if (!ipVerdict.allowed || !globalVerdict.allowed) {
    // Reuses the already-rendered "Too many requests" page; no new redirect target.
    redirect(`/login?error=${LOGIN_ERROR.RATE_LIMITED}`)
  }

  // --- The timed region begins here. Everything from now until the floor is padded to FLOOR_MS.
  const startedAt = Date.now()
  const email = String(formData.get('email') ?? '').trim()

  // SUCCESS and SUPPRESSED are different facts with one identical response; INVALID is the
  // malformed-address case, now floored rather than returned early.
  type Outcome = 'SUCCESS' | 'INVALID' | AuthFailureClass

  // Fail-safe default. If nothing below runs, we fail honestly rather than claiming success.
  let outcome: Outcome = 'UNAVAILABLE'
  let reason: string = UNCLASSIFIED_REASON

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Shape check only. Never tell the caller whether the address is registered. Set the outcome
    // and fall through to the floor + redirect rather than returning early, so a malformed
    // address is indistinguishable in the time domain from a real one.
    outcome = 'INVALID'
  } else {
    try {
      // createClient() and siteUrl() both THROW when their env vars are missing/malformed
      // (lib/env.ts); inside the try they become `unavailable:threw` and the honest error page,
      // not a framework crash screen. There is NO fallback to a request header — see the note.
      const supabase = await createClient()
      const origin = siteUrl()

      const send = supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${origin}/auth/callback`,
          shouldCreateUser: false,
        },
      })

      // Race the send against the floor. A send that overruns FLOOR_MS is abandoned and treated
      // as UNAVAILABLE, so no outcome can return later than the floor pads everything else to.
      const timeout: Promise<typeof TIMED_OUT> = sleep(FLOOR_MS).then(() => TIMED_OUT)
      const result = await Promise.race([send, timeout])

      if (result === TIMED_OUT) {
        outcome = 'UNAVAILABLE'
        reason = 'unavailable:timeout'
        // Swallow the abandoned send's eventual settle so it cannot become an unhandled rejection.
        // The underlying email may still go out server-side; only the response time is bounded.
        void Promise.resolve(send).catch(() => {})
        console.error('[login] signInWithOtp timed out:', reason)
      } else {
        const { error } = result
        if (!error) {
          outcome = 'SUCCESS'
          reason = 'ok'
        } else {
          const classified = classifyAuthError(error)
          outcome = classified.klass
          reason = classified.reason
          // Logged server-side only. "User not found" must never reach the client. 5.5b greps
          // this exact "failed: unavailable:" prefix, so keep it.
          console.error('[login] signInWithOtp failed:', reason, error.message)
          if (classified.reason === UNCLASSIFIED_REASON) {
            // Greppable marker for the load-bearing UNAVAILABLE-by-default branch.
            console.error(
              'UNCLASSIFIED_AUTH_ERROR [login] signInWithOtp: the auth error matched no known status or ' +
                'code branch and was classified UNAVAILABLE by default. ' +
                `status=${JSON.stringify(error.status)} code=${JSON.stringify(error.code)} ` +
                `name=${JSON.stringify(error.name)}`,
            )
          }
        }
      }
    } catch (thrown) {
      outcome = 'UNAVAILABLE'
      reason = 'unavailable:threw'
      console.error(
        '[login] signInWithOtp threw:',
        thrown instanceof Error ? thrown.message : String(thrown),
      )
    }
  }

  // --- The floor. Pad to FLOOR_MS, then jitter on top. Applies to every outcome above. --------
  const remaining = FLOOR_MS - (Date.now() - startedAt)
  if (remaining > 0) await sleep(remaining)
  await sleep(Math.floor(Math.random() * JITTER_MAX_MS))

  // redirect() works by THROWING NEXT_REDIRECT. Every redirect() call must stay outside the try
  // above, or the catch swallows it and the action falls through. This is the single most likely
  // way to break this fix. The target set is {?invalid=1, ?error=rate_limited, ?error=unavailable,
  // /login/check-email} — assertion 5.4 depends on there being no fifth.
  if (outcome === 'INVALID') redirect('/login?invalid=1')
  if (outcome === 'RATE_LIMITED') redirect(`/login?error=${LOGIN_ERROR.RATE_LIMITED}`)
  if (outcome === 'UNAVAILABLE') redirect(`/login?error=${LOGIN_ERROR.UNAVAILABLE}`)

  // SUCCESS and SUPPRESSED share ONE call site, deliberately. One call site is a structural
  // guarantee that the registered and unregistered responses can never drift apart.
  redirect('/login/check-email')
}
