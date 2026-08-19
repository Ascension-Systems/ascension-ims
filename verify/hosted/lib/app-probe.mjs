/**
 * Is the running application willing to accept the session cookie this harness minted?
 *
 * ------------------------------------------------------------------------------------
 * THIS MUST RUN BEFORE 4.9, OR A 401 THERE IS AMBIGUOUS
 * ------------------------------------------------------------------------------------
 * Without it, a 401 at 4.9 means either "the guard works" or "my cookie is malformed", and
 * those are opposite findings. The probe discriminates:
 *
 *   POST {PORTAL_BASE_URL}/api/commitments
 *     cookie: <rep session cookies>
 *     body:   { sku: KYV-0004, qty: 999999, location: 'kyv-verify' }
 *
 * An authenticated rep gets 409 INSUFFICIENT_AVAILABILITY
 * (app/api/commitments/route.ts:66-79). A caller the app does not recognise never reaches
 * the handler at all: `middleware.ts` matches /api/* and redirects an unauthenticated
 * request to /login before the route runs. Either way the probe FAILS, so it writes nothing.
 *
 * If the cookie is not accepted, every HTTP assertion reports
 * `NOT EXECUTED — rep session cookie not accepted by the app` rather than FAIL.
 */

import { appFetch, isLoginRedirect } from './client.mjs'
import { sessionCookieHeader, chunkCount } from './cookies.mjs'
import { KYV_LOCATION, SKU } from './fixtures.mjs'

export const NOT_EXECUTED_NO_BASE_URL =
  'NOT EXECUTED — PORTAL_BASE_URL not set; the app was not running'
export const NOT_EXECUTED_COOKIE_REJECTED =
  'NOT EXECUTED — rep session cookie not accepted by the app'

export async function probeAppSession(cfg, repSession) {
  if (!cfg.portalBaseUrl) {
    return { usable: false, reason: NOT_EXECUTED_NO_BASE_URL, cookie: null, chunks: 0, detail: '' }
  }

  const cookie = sessionCookieHeader(cfg.url, repSession)
  const chunks = chunkCount(cfg.url, repSession)

  const res = await appFetch(cfg.portalBaseUrl, '/api/commitments', {
    method: 'POST',
    cookie,
    body: { sku: SKU.CONT1, qty: 999999, location: KYV_LOCATION },
  })

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

  return {
    usable: true,
    reason: null,
    cookie,
    chunks,
    detail: `precondition probe answered HTTP ${res.status} (${JSON.stringify(res.body?.error ?? null)}); the app recognises the minted rep session. Cookie chunks: ${chunks}.`,
  }
}
