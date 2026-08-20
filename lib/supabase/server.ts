import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { cookieSecure, supabaseAnonKey, supabaseUrl } from '@/lib/env'

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
            // `secure` comes from cookieSecure() — true only when NEXT_PUBLIC_SITE_URL is an
            // https origin, so http://localhost development is unaffected. `sameSite` is left
            // alone deliberately: @supabase/ssr already supplies `lax` in `options`, which is
            // the correct value, and hardcoding it here would silently diverge if the vendor
            // default ever changed.
            cookieStore.set(name, value, {
              ...options,
              httpOnly: true,
              secure: cookieSecure(),
            })
          }
        } catch {
          // A Server Component cannot set cookies and throws here. The catch is safe
          // precisely because middleware refreshes the session on every request.
        }
      },
    },
  })
}
