/**
 * Classification of a Supabase auth error into what the user is allowed to be told.
 *
 * BRANCH ON status AND code. NEVER ON MESSAGE TEXT. Same house rule as lib/errors.ts.
 *
 * Shape measured against @supabase/auth-js 2.112.3:
 *   - `code` is OPTIONAL and genuinely not always populated. fetch.js sets it only when the body
 *     carries `data.code` AND response header x-supabase-api-version >= 2024-01-01, or when the
 *     body carries `data.error_code`. Otherwise undefined.
 *   - AuthApiError narrows status to number; AuthRetryableFetchError carries 500/503 or 0
 *     (connection refused); AuthUnknownError carries NEITHER status NOR code.
 *   - ErrorCode is a type-only union with no runtime enum, so the strings below are hardcoded
 *     deliberately. `invalid_api_key` is not in the union but is assignable via `(string & {})`.
 *
 * THE INVARIANT: anything not explicitly SUPPRESSED or RATE_LIMITED is UNAVAILABLE. The default
 * is the honest failure. A false success is never reachable. Do not add a branch that widens
 * SUPPRESSED without a ruling — SUPPRESSED is the branch that shows a success page.
 *
 * ------------------------------------------------------------------------------------
 * NO IMPORTS. THIS IS LOAD-BEARING, NOT AN OVERSIGHT.
 * ------------------------------------------------------------------------------------
 * This file imports nothing — not `@supabase/auth-js`, not the `@/` alias — so `tsc` can
 * compile it standalone without resolving the application's module graph. That is what lets
 * the verification harness execute THIS code (suite 5.1) rather than a mirror of it. The
 * vendor's `isAuthApiError` / `isAuthRetryableFetchError` guards were considered and rejected:
 * every branch below is decidable from `status` and `code` alone, so importing them would be
 * coupling with no payoff, and `@supabase/auth-js` is a hoisted transitive dependency that is
 * not declared in package.json.
 *
 * The tradeoff, stated plainly: this reimplements a classification the vendor also expresses,
 * so a future auth-js shape change could misclassify. Mitigations: the primary branch is
 * `status` (a plain number, the most stable field in the shape) with `code` as enrichment; the
 * measured version is pinned above; and hosted assertion 5.2 re-measures the real gateway's
 * error shape on every hosted run, so drift fails loudly instead of silently.
 *
 * ------------------------------------------------------------------------------------
 * THE INFERENCE NOTE — read before trusting the 401 branch
 * ------------------------------------------------------------------------------------
 * "HTTP 401 on this call means the anon key is bad" is an INFERENCE FROM ENDPOINT SEMANTICS,
 * not a measured fact. `signInWithOtp` is an unauthenticated endpoint and therefore has no
 * legitimate reason to answer 401. The invalid-anon-key case is precisely the case that can
 * leave `code` undefined, because it is rejected at the edge/gateway before GoTrue ever sees
 * the request; the real hosted shape could not be measured on the machine this was written on
 * (no credentials present, and none were requested). So: treat `status === 401` as the
 * discriminator and `code` as best-effort enrichment. Assertion 5.2 in
 * `verify/hosted/05-login-failure-modes.mjs` converts this inference into a measurement on
 * every hosted run, and records the observed status and code verbatim in the run notes.
 */

/** Query-param values on /login. Imported by actions.ts and asserted by the harness. */
export const LOGIN_ERROR = {
  UNAVAILABLE: 'unavailable',
  RATE_LIMITED: 'rate_limited',
} as const

export type AuthFailureClass = 'SUPPRESSED' | 'RATE_LIMITED' | 'UNAVAILABLE'

export type AuthErrorLike =
  | {
      status?: unknown
      code?: unknown
      name?: unknown
      message?: unknown
    }
  | null
  | undefined

/**
 * Address-specific conditions. Revealing any of these tells the caller whether an address is
 * registered, which with ~120 named reps is a real user-enumeration leak. These keep today's
 * behaviour EXACTLY: the same success page, server-side log only.
 */
const SUPPRESSED_CODES: ReadonlySet<string> = new Set([
  'user_not_found',
  'signup_disabled',
  'email_not_confirmed',
])

/**
 * Throttles. See the note in actions.ts about the enumeration tradeoff this branch carries.
 *
 * ------------------------------------------------------------------------------------
 * OPEN QUESTION, ESCALATED TO THE HUMAN — THIS IS THE ONE-LINE MOVE
 * ------------------------------------------------------------------------------------
 * `over_email_send_rate_limit` is the PER-ADDRESS throttle. With `shouldCreateUser: false`
 * the email-send path is only reached for addresses that are REGISTERED, so that code only
 * ever fires for a registered address. An attacker who submits the same address twice inside
 * the throttle window therefore gets the rate-limit page for a registered address and the
 * check-email page for an unregistered one: a reliable enumeration oracle against the same
 * ~120 named reps the anti-enumeration defence exists to protect.
 *
 * `over_request_rate_limit` is IP/route-level, address-independent, and carries no such leak.
 *
 * Implemented here as option (a) — as instructed: both codes classify RATE_LIMITED and the
 * user is told to wait and retry. Pending a ruling, option (b) is EXACTLY ONE LINE: move
 * `'over_email_send_rate_limit'` from this set into SUPPRESSED_CODES above (and update the
 * matching row in the 5.1 table in verify/login/predicate-cases.ts). Do not make that move
 * without the ruling, and do not delete this comment while the question is open.
 */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'over_request_rate_limit',
  'over_email_send_rate_limit',
])

export function classifyAuthError(error: AuthErrorLike): {
  klass: AuthFailureClass
  reason: string
} {
  // Misuse is fail-safe: never SUPPRESSED. classifyAuthError is only called with a real error.
  if (error === null || error === undefined) {
    return { klass: 'UNAVAILABLE', reason: 'unavailable:null-error' }
  }

  const code = typeof error.code === 'string' ? error.code : undefined
  const status = typeof error.status === 'number' ? error.status : undefined

  if (code !== undefined && SUPPRESSED_CODES.has(code)) {
    return { klass: 'SUPPRESSED', reason: `suppressed:${code}` }
  }
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return { klass: 'RATE_LIMITED', reason: `rate_limited:${code}` }
  }
  if (status === 429) {
    return { klass: 'RATE_LIMITED', reason: 'rate_limited:429' }
  }
  // An unauthenticated endpoint has no legitimate reason to answer 401. See the inference note.
  if (status === 401) {
    return { klass: 'UNAVAILABLE', reason: 'unavailable:401' }
  }
  if (status === 0) {
    return { klass: 'UNAVAILABLE', reason: 'unavailable:network' }
  }
  if (status !== undefined && status >= 500) {
    return { klass: 'UNAVAILABLE', reason: 'unavailable:5xx' }
  }
  // THE GAP CASE. AuthUnknownError has neither status nor code, and so does any future shape we
  // have not seen. It lands here on purpose. Removing this branch recreates the defect.
  return { klass: 'UNAVAILABLE', reason: 'unavailable:unclassified' }
}
