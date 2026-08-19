/**
 * The 5.1 table: every input shape `classifyAuthError` must decide, and the class it must
 * decide. One row here becomes one assertion in `verify/hosted/05-login-failure-modes.mjs`.
 *
 * ------------------------------------------------------------------------------------
 * THIS FILE IS DATA. THE CODE UNDER TEST IS app/login/auth-error.ts, UNMODIFIED.
 * ------------------------------------------------------------------------------------
 * The harness compiles `app/login/auth-error.ts` and this file together with `tsc` into
 * `verify/.out/` and imports BOTH. The predicate is the product's real function, not a copy
 * of it: a mirrored predicate would pass its own tests forever while the application diverged.
 *
 * The only import below is `import type`, which tsc erases at emit. That keeps the compiled
 * JavaScript free of any runtime import, which is what lets the two files be compiled
 * standalone with CLI flags and no tsconfig.
 *
 * Rows 1–12 are the measured shape table (@supabase/auth-js 2.112.3). Rows 13–17 are the
 * cases that decide whether the silent-failure defect can come back.
 *
 * TWO EXCEPTIONS, ADDED 2026-08-19: rows 5.1.3 (`otp_disabled`) and 5.1.7
 * (`over_email_send_rate_limit`) no longer state a purely measured shape. Their `input` is
 * still the measured shape; their `expected` now carries the 2026-08-19 ruling — *a security
 * predicate that branches on unmeasured vendor behaviour must fail toward the safe
 * classification until it is measured* — and both therefore expect SUPPRESSED. See the two
 * notes in `app/login/auth-error.ts`. Assertion 5.6g is the measurement that can reopen 5.1.3.
 *
 * 5.1.13 and 5.1.16 MUST NOT BE DELETED OR RELAXED. Together they state the property the
 * whole fix rests on: an error we have not seen is never reported to the user as a success.
 */

import type { AuthErrorLike, AuthFailureClass } from '../../app/login/auth-error'

export type PredicateCase = {
  /** Assertion id, printed by the harness. */
  id: string
  /** What the row asserts, in words. */
  description: string
  /** Passed to classifyAuthError verbatim. */
  input: AuthErrorLike
  expected: AuthFailureClass
}

export const PREDICATE_CASES: readonly PredicateCase[] = [
  {
    id: '5.1.1',
    description: 'status 401 with NO code -> UNAVAILABLE (the reproduced defect)',
    input: { status: 401, code: undefined },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.2',
    description: 'status 401, code invalid_api_key -> UNAVAILABLE',
    input: { status: 401, code: 'invalid_api_key' },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.3',
    description:
      'status 422, code otp_disabled -> SUPPRESSED (address-specificity unmeasured; fails to the safe side per the 2026-08-19 ruling)',
    input: { status: 422, code: 'otp_disabled' },
    expected: 'SUPPRESSED',
  },
  {
    id: '5.1.4',
    description: 'status 400, code user_not_found -> SUPPRESSED (anti-enumeration)',
    input: { status: 400, code: 'user_not_found' },
    expected: 'SUPPRESSED',
  },
  {
    id: '5.1.5',
    description: 'status 422, code signup_disabled -> SUPPRESSED (anti-enumeration)',
    input: { status: 422, code: 'signup_disabled' },
    expected: 'SUPPRESSED',
  },
  {
    id: '5.1.6',
    description: 'status 400, code email_not_confirmed -> SUPPRESSED (anti-enumeration)',
    input: { status: 400, code: 'email_not_confirmed' },
    expected: 'SUPPRESSED',
  },
  {
    id: '5.1.7',
    description:
      'status 429, code over_email_send_rate_limit -> SUPPRESSED (per-address throttle; RATE_LIMITED was an enumeration oracle)',
    input: { status: 429, code: 'over_email_send_rate_limit' },
    expected: 'SUPPRESSED',
  },
  {
    id: '5.1.8',
    description: 'status 429, code over_request_rate_limit -> RATE_LIMITED',
    input: { status: 429, code: 'over_request_rate_limit' },
    expected: 'RATE_LIMITED',
  },
  {
    id: '5.1.9',
    description: 'status 429 with NO code -> RATE_LIMITED',
    input: { status: 429, code: undefined },
    expected: 'RATE_LIMITED',
  },
  {
    id: '5.1.10',
    description: 'status 500 with NO code -> UNAVAILABLE',
    input: { status: 500, code: undefined },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.11',
    description: 'status 503 with NO code -> UNAVAILABLE',
    input: { status: 503, code: undefined },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.12',
    description: 'status 0 with NO code -> UNAVAILABLE (connection refused)',
    input: { status: 0, code: undefined },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.13',
    description: 'NEITHER status NOR code -> UNAVAILABLE (AuthUnknownError: the gap case)',
    input: { status: undefined, code: undefined },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.14',
    description: 'status 422, code validation_failed -> UNAVAILABLE (our request was malformed)',
    input: { status: 422, code: 'validation_failed' },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.15',
    description: 'status 400, code invalid_credentials -> UNAVAILABLE (anomalous on an OTP request)',
    input: { status: 400, code: 'invalid_credentials' },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.16',
    description: 'an unrecognised code -> UNAVAILABLE (forward-compatibility)',
    input: { status: 418, code: 'a_code_that_does_not_exist_yet' },
    expected: 'UNAVAILABLE',
  },
  {
    id: '5.1.17',
    description: 'null -> UNAVAILABLE (misuse is fail-safe)',
    input: null,
    expected: 'UNAVAILABLE',
  },
]
