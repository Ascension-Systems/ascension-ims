import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { supabaseAnonKey, supabaseUrl } from '@/lib/env'

/**
 * Server client for RSCs, server actions and route handlers. Cookie-bound, anon key only.
 *
 * Pages render through THIS client, not the service-role one, so the page itself is subject
 * to RLS -- meaning a policy bug shows up as missing data rather than as a silent leak.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // A Server Component cannot set cookies and throws here. The catch is safe
          // precisely because middleware refreshes the session on every request.
        }
      },
    },
  })
}
