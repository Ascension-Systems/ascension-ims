import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { supabaseUrl } from '@/lib/env'

/**
 * SERVICE-ROLE CLIENT. SERVER-SIDE ONLY.
 *
 * `import 'server-only'` makes a build fail loudly if this module is ever pulled into a
 * client component, rather than shipping the key to the browser. A `no-restricted-imports`
 * rule in .eslintrc.json additionally limits importers to app/api/** and
 * lib/inventory-source.stub.ts.
 *
 * SUPABASE_SERVICE_ROLE_KEY is read in this file and nowhere else in application code. It is
 * never prefixed NEXT_PUBLIC_.
 *
 * This client BYPASSES ROW LEVEL SECURITY. It is never used to render a page.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new Error(
      'Missing environment variable SUPABASE_SERVICE_ROLE_KEY. It is server-side only and ' +
        'must never be prefixed NEXT_PUBLIC_. Set it in .env.local locally, or in the ' +
        'Netlify dashboard for a deployed build.',
    )
  }

  return createSupabaseClient(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
