import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile } from '@/lib/types'

/**
 * Session and role helpers.
 *
 * These are NOT the access control. Role is enforced in the database by RLS (migration 0011)
 * and by the is_admin() guard inside apply_inventory_sync (migration 0010). requireAdmin()
 * exists so a route handler can return a clean 403 instead of a 500 -- every one of these has
 * a database refusal underneath it.
 */

/**
 * Always getUser(), never getSession(): getUser() revalidates with the auth server.
 *
 * Wrapped in React cache() so the layout and the page it renders — which both call requireUser()
 * and getProfile() — share ONE revalidation per request instead of each firing its own GoTrue
 * round trip. On an authenticated nav that collapsed ~5 sequential auth calls to 1–2.
 */
export const getUser = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})

export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await getUser()
  if (!user) return null

  const supabase = await createClient()
  const { data } = await supabase
    .from('profiles')
    .select('id, email, role, created_at')
    .eq('id', user.id)
    .maybeSingle()

  return (data as Profile | null) ?? null
})

/** Redirects to /login when there is no session. Used by pages. */
export async function requireUser() {
  const user = await getUser()
  if (!user) redirect('/login')
  return user
}

export type AdminCheck =
  | { ok: true; profile: Profile }
  | { ok: false; reason: 'NOT_AUTHENTICATED' | 'FORBIDDEN_ROLE' }

/** Used by route handlers, which return a status rather than redirecting. */
export async function requireAdmin(): Promise<AdminCheck> {
  const profile = await getProfile()
  if (!profile) return { ok: false, reason: 'NOT_AUTHENTICATED' }
  if (profile.role !== 'admin') return { ok: false, reason: 'FORBIDDEN_ROLE' }
  return { ok: true, profile }
}
