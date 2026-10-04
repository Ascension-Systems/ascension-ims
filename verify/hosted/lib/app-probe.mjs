/**
 * Is the running application willing to accept the session cookie this harness minted?
 *
 * ------------------------------------------------------------------------------------
 * THIS MUST RUN BEFORE 4.9, OR A 401 THERE IS AMBIGUOUS
 * ------------------------------------------------------------------------------------
 * Without it, a 401 at 4.9 means either "the guard works" or "my cookie is malformed", and
 * those are opposite findings. The probe discriminates:
 *
 *   POST {PORTAL_BASE_URL}/api/documents
 *     cookie: <rep session cookies>      (no body)
 *
 * An authenticated rep gets 403 FORBIDDEN_ROLE from requireAdmin(), the first statement of
 * the POST handler in app/api/documents/route.ts, before the request body is even read. A
 * caller the app does not recognise never reaches the handler at all: `middleware.ts` matches
 * /api/* and redirects an unauthenticated request to /login before the route runs. Either way
 * the probe writes nothing. (Until 0025 this probe used /api/commitments, which no longer
 * exists. It deliberately does NOT use /api/sync: that is 4.9's own subject, and a broken
 * guard there would let the probe run a real sync.)
 *
 * If the cookie is not accepted, every HTTP assertion reports
 * `NOT EXECUTED — rep session cookie not accepted by the app` rather than FAIL.
 */

import { appFetch, isLoginRedirect } from './client.mjs'
import { sessionCookieHeader, chunkCount } from './cookies.mjs'

export const NOT_EXECUTED_NO_BASE_URL =
  'NOT EXECUTED — PORTAL_BASE_URL not set; the app was not running'
export const NOT_EXECUTED_COOKIE_REJECTED =
  'NOT EXECUTED — rep session cookie not accepted by the app'
export const NOT_EXECUTED_PROBE_UNEXPECTED =
  'NOT EXECUTED — app-session probe got an unexpected answer (not 403 FORBIDDEN_ROLE)'

export async function probeAppSession(cfg, repSession) {
  if (!cfg.portalBaseUrl) {
    return { usable: false, reason: NOT_EXECUTED_NO_BASE_URL, cookie: null, chunks: 0, detail: '' }
  }

  const cookie = sessionCookieHeader(cfg.url, repSession)
  const chunks = chunkCount(cfg.url, repSession)

  const res = await appFetch(cfg.portalBaseUrl, '/api/documents', { method: 'POST', cookie })

  if (!res.ok) {
    return {
      usable: false,
      reason: NOT_EXECUTED_NO_BASE_URL,
      cookie,
      chunks,
      detail: `PORTAL_BASE_URL is set but the app was unreachable: ${res.error}`,
    }
  }

  if (res.status === 401 || isLoginRedirect(res)) {
    return {
      usable: false,
      reason: NOT_EXECUTED_COOKIE_REJECTED,
      cookie,
      chunks,
      detail:
        `the precondition probe was answered with HTTP ${res.status}` +
        `${res.location ? ` -> ${res.location}` : ''}, which is what the app returns for a ` +
        `caller it does not recognise. The session cookie was split into ${chunks} chunk(s).`,
    }
  }

  // POSITIVE only: exactly the documented rep answer. A 404 (route missing), a 500, or any
  // other status says nothing about whether the app recognised the session, so it is not
  // treated as proof that it did.
  if (res.status !== 403 || res.body?.error !== 'FORBIDDEN_ROLE') {
    return {
      usable: false,
      reason: NOT_EXECUTED_PROBE_UNEXPECTED,
      cookie,
      chunks,
      detail:
        `the precondition probe expected HTTP 403 FORBIDDEN_ROLE and was answered with HTTP ${res.status} ` +
        `(${JSON.stringify(res.body?.error ?? null)})${res.location ? ` -> ${res.location}` : ''}. ` +
        `Cookie chunks: ${chunks}.`,
    }
  }

  return {
    usable: true,
    reason: null,
    cookie,
    chunks,
    detail: `precondition probe answered HTTP 403 FORBIDDEN_ROLE; the app recognises the minted rep session. Cookie chunks: ${chunks}.`,
  }
}
