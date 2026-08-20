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
 * SUPPRESSED WAS WIDENED ON 2026-08-19, UNDER A RULING, NOT AGAINST THIS RULE. chris adopted:
 * *a security predicate that branches on unmeasured vendor behaviour must fail toward the safe
 * classification until it is measured.* `otp_disabled` and `over_email_send_rate_limit` moved
 * into SUPPRESSED_CODES under that ruling. See the two notes below — the one above
 * SUPPRESSED_CODES records what is still unmeasured about `otp_disabled` and names the
 * assertion that will measure it; the one above RATE_LIMIT_CODES records the closed question
 * and what suppressing a throttle code costs. The rule stands for the next change: the next
 * person to widen SUPPRESSED still needs a ruling, and this entry is not one.
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

/** The reason the default branch emits. Exported so the call site can key on it by identity. */
export const UNCLASSIFIED_REASON = 'unavailable:unclassified'

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
 *
 * ------------------------------------------------------------------------------------
 * `otp_disabled` — WHY IT IS HERE, AND WHAT IS STILL UNMEASURED ABOUT IT
 * ------------------------------------------------------------------------------------
 * Added 2026-08-19. Two readings of the same vendor code exist and they disagree:
 *
 *   builder inferred it is PROJECT-WIDE — GoTrue answers `otp_disabled` when the project has
 *     email OTP turned off, for any address, so disclosing it discloses nothing about an
 *     address.
 *   auditor inferred it is ADDRESS-SPECIFIC under `shouldCreateUser: false` — the code can be
 *     reached on a path that has already resolved the address, so seeing it can imply the
 *     address is registered.
 *
 * BOTH ARE INFERENCES FROM READING `node_modules`. NEITHER IS A MEASUREMENT. Under the
 * 2026-08-19 ruling — a security predicate that branches on unmeasured vendor behaviour must
 * fail toward the safe classification until it is measured — unmeasured resolves SUPPRESSED,
 * because SUPPRESSED is the classification that cannot leak an address.
 *
 * Assertion 5.6g measures, on a hosted run, whether the real GoTrue answers `otp_disabled` for
 * a constant unregistered address under `shouldCreateUser: false`. If it does, `otp_disabled`
 * is project-wide and this row may be revisited under a fresh ruling. Until 5.6g has run and
 * been read, this stays SUPPRESSED. 5.6g lives in
 * `verify/hosted/05-login-failure-modes.mjs` and reads `GET /api/health/auth`.
 *
 * The cost of suppressing a project-wide failure mode — that a project with OTP switched off
 * looks healthy to every rep — is paid, not absorbed: `GET /api/health/auth` reports
 * `otpEnabled: "no"` and `verdict: "broken"` for exactly that condition, from the server side,
 * without an address and without a session.
 *
 * `over_email_send_rate_limit` was moved in here from RATE_LIMIT_CODES on the same date. Its
 * note is below, above RATE_LIMIT_CODES, where the open question was originally recorded.
 */
export const SUPPRESSED_CODES: ReadonlySet<string> = new Set([
  'user_not_found',
  'signup_disabled',
  'email_not_confirmed',
  'otp_disabled',
  'over_email_send_rate_limit',
])

/**
 * Throttles. See the note in actions.ts about the enumeration tradeoff this branch carries.
 *
 * ------------------------------------------------------------------------------------
 * CLOSED QUESTION — KEPT AS THE RECORD OF WHY, NOT AS A LIVE ESCALATION
 * ------------------------------------------------------------------------------------
 * This block used to be headed "OPEN QUESTION, ESCALATED TO THE HUMAN". It is not open: the
 * ruling arrived and was applied, and the RESOLUTION immediately below is the outcome. The
 * heading is corrected because a security comment that announces an unresolved question above
 * code that already resolved it invites the next reader to re-open a settled decision, or to
 * "finish" a move that has already been made. The history is worth keeping; the stale framing
 * is not.
 *
 * THE LEAK THIS DESCRIBES IS FIXED. It is retained because it states WHY the current
 * membership is what it is, and anyone proposing to move `over_email_send_rate_limit` back
 * into this set needs to have read it:
 *
 * `over_email_send_rate_limit` is the PER-ADDRESS throttle. With `shouldCreateUser: false`
 * the email-send path is only reached for addresses that are REGISTERED, so that code only
 * ever fires for a registered address. An attacker who submits the same address twice inside
 * the throttle window therefore got the rate-limit page for a registered address and the
 * check-email page for an unregistered one: a reliable enumeration oracle against the same
 * ~120 named reps the anti-enumeration defence exists to protect. Classifying it SUPPRESSED
 * is what removed that oracle.
 *
 * `over_request_rate_limit` is IP/route-level, address-independent, and carries no such leak,
 * which is why it is the one member this set retains.
 *
 * The original instruction implemented option (a) — both codes RATE_LIMITED. Option (b) was
 * the one-line move of `'over_email_send_rate_limit'` into SUPPRESSED_CODES, with the matching
 * row in verify/login/predicate-cases.ts. OPTION (b) HAS BEEN TAKEN; both halves are done.
 *
 * ------------------------------------------------------------------------------------
 * RESOLUTION — 2026-08-19. THE QUESTION IS CLOSED. OPTION (b) WAS TAKEN.
 * ------------------------------------------------------------------------------------
 * The ruling, verbatim:
 *
 *   "A security predicate that branches on unmeasured vendor behaviour must fail toward the
 *    safe classification until it is measured."
 *
 * `over_email_send_rate_limit` is now a member of SUPPRESSED_CODES above and is no longer a
 * member of this set. The registered and unregistered responses are therefore identical INSIDE
 * the per-address throttle window as well as outside it, which is what removes the oracle
 * described above.
 *
 * THE COST, STATED RATHER THAN ABSORBED. Suppressing this code re-hides a project-wide failure
 * mode: a throttled or misconfigured project answers every rep with the same "check your email"
 * page it answers a healthy one with. That cost is paid by the server-side configuration health
 * signal at `GET /api/health/auth` (`app/api/health/auth/route.ts`), which reports the same
 * conditions from the server, with no address, no session and no user input. It is not absorbed
 * and it is not left to be noticed.
 *
 * This set correctly retains EXACTLY ONE member. Do not delete the set: the `status === 429`
 * branch in classifyAuthError below and invariants 5.C2 and 5.C5 both depend on it existing.
 */
export const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['over_request_rate_limit'])

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
  //
  // The reason is UNCLASSIFIED_REASON rather than a repeated literal so that the call site in
  // actions.ts can recognise THIS branch by identity and log the UNCLASSIFIED_AUTH_ERROR
  // marker. Widening that recognition to any other UNAVAILABLE reason would make the marker
  // meaningless: `unavailable:401`, `unavailable:network`, `unavailable:5xx`,
  // `unavailable:null-error` and `unavailable:threw` are all classified branches, not this one.
  return { klass: 'UNAVAILABLE', reason: UNCLASSIFIED_REASON }
}
