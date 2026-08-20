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
            // `httpOnly: true` is set here rather than left at @supabase/ssr's default
            // (`false`). No browser Supabase client is wired up in step 1 —
            // `lib/supabase/client.ts` has zero importers — so nothing reads this cookie from
            // JavaScript. If step 2 introduces a browser client, this is the line that will
            // need a measured decision, not a silent revert.
            //
            // `secure` and `sameSite` are deliberately NOT set: `secure: true` breaks
            // http://localhost development and neither is in scope for this finding.
            cookieStore.set(name, value, { ...options, httpOnly: true })
          }
        } catch {
          // A Server Component cannot set cookies and throws here. The catch is safe
          // precisely because middleware refreshes the session on every request.
        }
      },
    },
  })
}
