import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { supabaseAnonKey, supabaseUrl } from '@/lib/env'

/** Routes reachable without a session. Everything else redirects to /login. */
const PUBLIC_PATHS = ['/login', '/login/check-email', '/auth/callback', '/auth/auth-code-error']

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
          request.cookies.set(name, value)
        }
        supabaseResponse = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options)
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
