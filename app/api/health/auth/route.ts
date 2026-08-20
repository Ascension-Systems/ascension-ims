import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabaseAnonKey, supabaseUrl } from '@/lib/env'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'

/**
 * GET /api/health/auth — the server-side configuration health signal.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS EXISTS. IT IS THE COST OF THE 2026-08-19 RULING, PAID RATHER THAN ABSORBED.
 * ------------------------------------------------------------------------------------
 * `app/login/auth-error.ts` classifies `otp_disabled` and `over_email_send_rate_limit` as
 * SUPPRESSED, so a project with OTP switched off — or one throttling every send — answers every
 * rep with the same "check your email" page a healthy project answers. That is the correct
 * user-facing behaviour (it cannot leak whether an address is registered) and it re-hides a
 * project-wide failure in which NOBODY can sign in. This endpoint reports that failure from the
 * server side, with no address and no session, so the cost is paid instead of noticed later.
 *
 * ------------------------------------------------------------------------------------
 * IT IS UNAUTHENTICATED, DELIBERATELY.
 * ------------------------------------------------------------------------------------
 * The failure it exists to surface — OTP disabled project-wide, or a rotated anon key — means
 * NOBODY CAN OBTAIN A SESSION. An authenticated or admin-gated health check is useless in
 * precisely the scenario it was built for. So it is unauthenticated, and made safe BY
 * CONSTRUCTION instead:
 *
 *   - it accepts NO INPUT OF ANY KIND. No body, no query parameters, no headers except the one
 *     the rate limiter reads. A query string is ignored, never parsed, never echoed.
 *   - the probe address is a MODULE CONSTANT in the reserved `.invalid` TLD. It is not
 *     configurable and never will be.
 *   - the response has exactly five keys and four of them draw from closed vocabularies. There
 *     is no free-text field, so there is nothing for a key, an address or a vendor message to
 *     leak through.
 *   - it reveals no key material, no address and no registration status.
 *   - it is rate-limited BEFORE it touches the vendor, so a rejected request costs zero GoTrue
 *     traffic.
 *
 * `lib/supabase/middleware.ts` lists this path in PUBLIC_PATHS; without that the middleware
 * would redirect the unauthenticated GET to /login and the endpoint would be dead on arrival.
 *
 * ------------------------------------------------------------------------------------
 * NO FREE TEXT ON THE 200 RESPONSE. DO NOT ADD ANY.
 * ------------------------------------------------------------------------------------
 * There is no `notes`, `detail`, `message`, `error` or `reason` field on the success body, and
 * none may be added. Free text is how a key, an address or a vendor message leaks out of a
 * health endpoint. Explanations live in README.md, keyed by `verdict`.
 *
 * `verdict` is NOT called "ok". `otpEnabled` can never be proven (see below), so claiming "ok"
 * would be the same class of false-healthy claim this whole rework exists to remove.
 * `no_fault_detected` is the honest word. Do not rename it.
 */

/**
 * THE PROBE ADDRESS. A MODULE CONSTANT, NEVER CONFIGURABLE, NEVER USER-SUPPLIED.
 *
 * `.invalid` is reserved by RFC 2606: it can never be registered and can never receive mail.
 * Because it is a constant that cannot be registered, the answer GoTrue gives for it carries no
 * information about any real address — which is what makes an address-free measurement possible
 * at all.
 */
const HEALTH_PROBE_ADDRESS = 'portal-health-probe@example.invalid'

const RATE_LIMIT = 6
const RATE_WINDOW_MS = 60_000

/** Never statically cached: a cached health signal is a stale health signal. */
export const dynamic = 'force-dynamic'

type Tri = 'yes' | 'no' | 'unknown'

/**
 * `"yes"` is not in this union. The probe is one-sided: it can prove OTP is disabled and can
 * never prove it is enabled. Do not add `"yes"` without a measurement. Assertion 5.6g is that
 * measurement.
 *
 * Why one-sided: if GoTrue answers `otp_disabled` for a constant address that cannot be
 * registered, OTP is off project-wide and that is conclusive. Any other answer is
 * INCONCLUSIVE — under one reading `otp_disabled` may be masked by `user_not_found`, and
 * whether this project's GoTrue returns a bare 200 for an unknown address is itself unmeasured.
 */
type OtpEnabled = 'no' | 'unknown'

type Verdict = 'broken' | 'no_fault_detected' | 'unmeasured'

type HealthBody = {
  checkedAt: string
  authEndpointReachable: Tri
  anonKeyAccepted: Tri
  otpEnabled: OtpEnabled
  verdict: Verdict
}

type Mapped = {
  authEndpointReachable: Tri
  anonKeyAccepted: Tri
  otpEnabled: OtpEnabled
  verdict: Verdict
}

/**
 * THIS DELIBERATELY DOES NOT REUSE `classifyAuthError`.
 *
 * That predicate answers "what may the user be told"; this answers "what is broken
 * project-wide". Since the 2026-08-19 ruling, `over_email_send_rate_limit` and `otp_disabled`
 * both classify SUPPRESSED there — reading `klass` here would report a disabled project as
 * healthy. Different question, different mapping.
 *
 * Branch on `status` and `code`, NEVER on message text (same house rule as `lib/errors.ts`).
 * The order below is the evaluation order and the final row is the fail-safe: an unrecognised
 * shape never yields `no_fault_detected`.
 */
function mapObservation(threw: boolean, status: number | undefined, code: string | undefined): Mapped {
  if (threw || status === 0) {
    return {
      authEndpointReachable: 'no',
      anonKeyAccepted: 'unknown',
      otpEnabled: 'unknown',
      verdict: 'broken',
    }
  }
  if (code === 'otp_disabled') {
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'yes',
      otpEnabled: 'no',
      verdict: 'broken',
    }
  }
  if (status === 401 || code === 'invalid_api_key') {
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'no',
      otpEnabled: 'unknown',
      verdict: 'broken',
    }
  }
  if (status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'unknown',
      otpEnabled: 'unknown',
      verdict: 'unmeasured',
    }
  }
  if (status !== undefined && status >= 500) {
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'unknown',
      otpEnabled: 'unknown',
      verdict: 'broken',
    }
  }
  if (code === 'user_not_found' || code === 'signup_disabled') {
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'yes',
      otpEnabled: 'unknown',
      verdict: 'no_fault_detected',
    }
  }
  if (status === undefined && code === undefined) {
    // No error at all: the request was accepted. Reachable, key accepted, OTP state unproven.
    return {
      authEndpointReachable: 'yes',
      anonKeyAccepted: 'yes',
      otpEnabled: 'unknown',
      verdict: 'no_fault_detected',
    }
  }
  // THE FAIL-SAFE. An unrecognised shape is never reported as healthy.
  return {
    authEndpointReachable: 'yes',
    anonKeyAccepted: 'unknown',
    otpEnabled: 'unknown',
    verdict: 'unmeasured',
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function body(mapped: Mapped): HealthBody {
  return {
    checkedAt: new Date().toISOString(),
    authEndpointReachable: mapped.authEndpointReachable,
    anonKeyAccepted: mapped.anonKeyAccepted,
    otpEnabled: mapped.otpEnabled,
    verdict: mapped.verdict,
  }
}

export async function GET(request: Request) {
  // BEFORE any vendor call, so a rejected request costs zero GoTrue traffic.
  const rl = checkRateLimit('health:auth', clientIpKey(request.headers), RATE_LIMIT, RATE_WINDOW_MS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      {
        status: 429,
        headers: { ...JSON_HEADERS, 'retry-after': String(rl.retryAfterSeconds) },
      },
    )
  }

  // Configuration missing. 200 with everything unknown, because "we could not measure" is a
  // real and useful answer and is not the same thing as "the request was malformed". The env
  // error message is logged server-side and NEVER returned.
  let url: string
  let anonKey: string
  try {
    url = supabaseUrl()
    anonKey = supabaseAnonKey()
  } catch (err) {
    console.error(
      '[api/health/auth] configuration missing:',
      err instanceof Error ? err.message : String(err),
    )
    return NextResponse.json(
      body({
        authEndpointReachable: 'unknown',
        anonKeyAccepted: 'unknown',
        otpEnabled: 'unknown',
        verdict: 'unmeasured',
      }),
      { status: 200, headers: JSON_HEADERS },
    )
  }

  // A session-less client, built the same way verify/hosted/05-login-failure-modes.mjs builds
  // its probe client. NOT lib/supabase/server.ts: the health check must not be cookie-bound.
  // NOT lib/supabase/admin.ts and never SUPABASE_SERVICE_ROLE_KEY: this endpoint is public.
  let threw = false
  let status: number | undefined
  let code: string | undefined
  try {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { error } = await client.auth.signInWithOtp({
      email: HEALTH_PROBE_ADDRESS,
      options: { shouldCreateUser: false },
    })
    if (error) {
      status = typeof error.status === 'number' ? error.status : undefined
      code = typeof error.code === 'string' ? error.code : undefined
    }
  } catch {
    threw = true
  }

  const mapped = mapObservation(threw, status, code)

  // Exactly one line per completed probe, never on a 429. Never the address, never any part of
  // any key, never the URL.
  const line = `status=${JSON.stringify(status)} code=${JSON.stringify(code)}`
  if (mapped.verdict === 'broken') {
    console.error('[api/health/auth] probe:', mapped.verdict, line)
  } else {
    console.info('[api/health/auth] probe:', mapped.verdict, line)
  }

  return NextResponse.json(body(mapped), { status: 200, headers: JSON_HEADERS })
}

/**
 * GET only. POST exists solely so the refusal is explicit and carries `Allow`, rather than
 * arriving as a framework 405 with no header. It performs no vendor call, so it is not
 * rate-limited — the limiter exists to keep rejected traffic off GoTrue, and this path never
 * reaches GoTrue.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'METHOD_NOT_ALLOWED' },
    { status: 405, headers: { ...JSON_HEADERS, allow: 'GET' } },
  )
}
