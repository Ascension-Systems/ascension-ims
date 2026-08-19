'use client'

import { createBrowserClient } from '@supabase/ssr'
import { supabaseAnonKey, supabaseUrl } from '@/lib/env'

/**
 * Browser client. ANON KEY ONLY.
 *
 * The service-role key must never reach the browser and is never prefixed NEXT_PUBLIC_.
 */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey())
}
