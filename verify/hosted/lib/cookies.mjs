/**
 * Building the @supabase/ssr session cookie the running app will actually accept.
 *
 * ------------------------------------------------------------------------------------
 * THE COOKIE IS CHUNKED. ASSUMING A SINGLE COOKIE PRODUCES A 401 WHERE A 403 WAS EXPECTED,
 * WHICH READS AS A FAILED ASSERTION RATHER THAN AS A BROKEN HARNESS.
 * ------------------------------------------------------------------------------------
 * Verified against the installed packages rather than from memory:
 *
 *   - storage key: `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
 *     (@supabase/supabase-js/dist/index.mjs:635)
 *   - lib/supabase/server.ts passes no cookieOptions.name and no cookieEncoding, so the
 *     default applies: cookieEncoding 'base64url'
 *     (@supabase/ssr/dist/main/createServerClient.js:16)
 *   - the stored value is JSON.stringify(session) (auth-js setItemAsync), written as
 *     'base64-' + base64url(that JSON) (@supabase/ssr/dist/main/cookies.js:444-446)
 *   - if encodeURIComponent(value).length exceeds MAX_CHUNK_SIZE = 3180 it is split into
 *     `<name>.0`, `<name>.1`, … (@supabase/ssr/dist/main/utils/chunker.js). A Supabase
 *     session JSON is routinely over that.
 *
 * `createChunks` is IMPORTED from @supabase/ssr rather than reimplemented, so the chunking
 * is byte-identical to what the application's own reader expects — including its unicode
 * boundary handling. @supabase/ssr is already a production dependency of this project.
 *
 * The session value itself is never printed, logged or written to disk.
 */

import { createChunks } from '@supabase/ssr'

/** Same derivation the SupabaseClient constructor uses for its default storage key. */
export function storageKeyFor(supabaseUrl) {
  const host = new URL(supabaseUrl).hostname
  return `sb-${host.split('.')[0]}-auth-token`
}

/**
 * Returns the cookie name/value pairs a browser would hold after this session was written.
 * Value encoding matches @supabase/ssr's base64url path exactly; its own test asserts
 * stringToBase64URL(x) === Buffer.from(x).toString('base64url').
 */
export function sessionCookiePairs(supabaseUrl, session) {
  const key = storageKeyFor(supabaseUrl)
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  return createChunks(key, encoded)
}

/** A ready-to-send `Cookie:` header. Values are percent-encoded, as `cookie.serialize` does. */
export function sessionCookieHeader(supabaseUrl, session) {
  return sessionCookiePairs(supabaseUrl, session)
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join('; ')
}

/** How many cookies the session split into. Printed so a chunking regression is visible. */
export function chunkCount(supabaseUrl, session) {
  return sessionCookiePairs(supabaseUrl, session).length
}
