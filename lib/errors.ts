/**
 * SQLSTATE -> HTTP mapping.
 *
 * Route handlers branch on the SQLSTATE (surfaced by @supabase/supabase-js as
 * PostgrestError.code), NEVER on message text.
 */

export type ApiErrorBody = {
  error: string
  message: string
  [key: string]: unknown
}

type Mapping = { status: number; error: string; message: string }

const MAP: Record<string, Mapping> = {
  KY001: {
    status: 409,
    error: 'INSUFFICIENT_AVAILABILITY',
    message: 'Another rep committed the last unit first.',
  },
  KY002: { status: 401, error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' },
  KY003: { status: 403, error: 'FORBIDDEN_ROLE', message: 'This action requires an admin account.' },
  KY004: { status: 400, error: 'INVALID_INPUT', message: 'That request was not valid.' },
  KY005: { status: 404, error: 'UNKNOWN_SKU_LOCATION', message: 'No such product at that location.' },
  KY006: {
    status: 409,
    error: 'ILLEGAL_TRANSITION',
    message: 'That change is not allowed for this record.',
  },
  '42501': { status: 403, error: 'FORBIDDEN', message: 'You do not have access to that.' },
}

export type PostgresErrorLike = {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

const INTERNAL: Mapping = {
  status: 500,
  error: 'INTERNAL',
  message: 'Something went wrong. Please try again.',
}

/**
 * `Object.hasOwn` rather than a bare `MAP[code]`, deliberately.
 *
 * A plain index into an object literal also resolves inherited keys, so `code` values of
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` or `__proto__` return a truthy
 * non-Mapping from Object.prototype instead of falling through to INTERNAL. The `?? {...}`
 * fallback does not catch that: the value is not null or undefined, it is a function. The
 * caller would then read `.status` and `.error` off it, get undefined for both, and hand
 * undefined to NextResponse.json(body, { status: undefined }).
 *
 * NOT REACHABLE TODAY: `code` is a PostgreSQL SQLSTATE arriving via PostgrestError, and
 * SQLSTATEs are five alphanumeric characters, so none of those strings can appear. This is
 * closed because the guarantee is a property of the CALLER (that nothing attacker-influenced
 * ever reaches this argument), the function itself cannot enforce it, and a lookup table
 * indexed by an outside value is a pattern a review flags on sight. One line to make the
 * fallback actually total.
 */
export function mapPostgresError(error: PostgresErrorLike | null | undefined): Mapping {
  const code = error?.code ?? ''
  return Object.hasOwn(MAP, code) ? MAP[code]! : INTERNAL
}

/**
 * Parses the availability figure out of record_commitment's KY001 message so the client can
 * be told how many are actually left.
 *
 * The BRANCH is on the SQLSTATE, never on this text. This only enriches an already-decided
 * 409 response, and returns null rather than throwing if the message shape ever changes.
 */
export function parseInsufficientAvailability(
  message: string | null | undefined,
): { requested: number; available: number } | null {
  if (!message) return null
  const m = /requested (-?\d+), available (-?\d+)/.exec(message)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  return { requested: Number(m[1]), available: Number(m[2]) }
}
