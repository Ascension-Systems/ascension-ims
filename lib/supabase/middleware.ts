import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { cookieSecure, supabaseAnonKey, supabaseUrl } from '@/lib/env'

/**
 * Routes reachable without a session. Everything else redirects to /login.
 *
 * `/api/health/auth` is public DELIBERATELY. The failure it exists to surface — OTP disabled
 * project-wide, or a rotated anon key — is precisely the failure in which NOBODY can obtain a
 * session, so an authenticated health check would be useless exactly when it is needed. It is
 * made safe by construction instead: no input of any kind, a module-constant probe address, a
 * closed response vocabulary, no free-text field, and a rate limiter that runs before it
 * touches the vendor. See app/api/health/auth/route.ts.
 */
const PUBLIC_PATHS = [
  '/login',
  '/login/check-email',
  '/auth/callback',
  '/auth/auth-code-error',
  '/api/health/auth',
]

const isPublic = (pathname: string) =>
  PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

/**
 * Refreshes the session and applies the unauthenticated redirect.
 *
 * MIDDLEWARE IS CONVENIENCE, NOT ACCESS CONTROL. It runs before the request reaches a route
 * and is exactly the kind of thing bypassed by a direct API call. The real gate is the
 * database (migration 0011).
 *
 * Four rules here, all of which cause silent, intermittent sign-outs when broken:
 *   1. Use getUser(), never getSession(). getUser() revalidates the token with the auth
 *      server; getSession() trusts whatever is in the cookie.
 *   2. No code between createServerClient(...) and await supabase.auth.getUser().
 *   3. When constructing a redirect response, copy the cookies from supabaseResponse onto it
 *      (or return supabaseResponse itself). Returning a bare NextResponse.next() drops the
 *      refreshed tokens and signs the user out a few minutes later, seemingly at random.
 *   4. setAll writes to BOTH request.cookies and the response.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          // NOT given httpOnly, deliberately. This mutates the in-memory REQUEST
          // representation so the rest of this request sees the refreshed token; it does not
          // emit a Set-Cookie header. It takes no options today and must keep taking none.
          request.cookies.set(name, value)
        }
        supabaseResponse = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          // THIS is the writer that produces a Set-Cookie header, and it is the one that gets
          // the flag. `httpOnly: true` is set here rather than left at @supabase/ssr's default
          // (`false`). No browser Supabase client is wired up in step 1 —
          // `lib/supabase/client.ts` has zero importers — so nothing reads this cookie from
          // JavaScript. If step 2 introduces a browser client, this is the line that will need
          // a measured decision, not a silent revert.
          //
          // `secure` comes from cookieSecure() — true only when NEXT_PUBLIC_SITE_URL is an
          // https origin, so http://localhost development is unaffected. `sameSite` is left
          // alone deliberately: @supabase/ssr already supplies `lax` in `options`, which is
          // the correct value, and hardcoding it here would silently diverge if the vendor
          // default ever changed.
          //
          // The server-side READ path is unaffected. `getAll()` above reads the inbound
          // Cookie header, which httpOnly does not touch.
          supabaseResponse.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            secure: cookieSecure(),
          })
        }
      },
    },
  })

  // Rule 2: nothing between the client construction above and this call.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    const redirect = NextResponse.redirect(url)
    // Rule 3.
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirect.cookies.set(cookie)
    }
    return redirect
  }

  if (user && (pathname === '/login' || pathname === '/login/check-email')) {
    const url = request.nextUrl.clone()
    url.pathname = '/inventory'
    url.search = ''
    const redirect = NextResponse.redirect(url)
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirect.cookies.set(cookie)
    }
    return redirect
  }

  return supabaseResponse
}
