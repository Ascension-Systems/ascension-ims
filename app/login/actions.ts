'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'

/**
 * Magic-link request. No password fields, no reset flow, no credential storage.
 *
 * shouldCreateUser: false is DELIBERATE. Users are pre-provisioned by the Human in the
 * Supabase dashboard. Left at the default, anyone on the internet with any email address
 * could self-register into a portal showing a client's inventory. (Plan decision A1;
 * README.md documents how the Human provisions a user and sets their role.)
 *
 * THE RESPONSE IS ALWAYS THE SAME, whether or not the address exists. Revealing which
 * addresses are registered is a user-enumeration leak, and with ~120 named external reps it
 * is a real one. Errors are logged server-side and the same success shape is returned.
 *
 * Rate limiting is Supabase's built-in per-address throttle. Nothing hand-rolled.
 */
export async function requestMagicLink(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()

  // Shape check only. Never tell the caller whether the address is registered.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect('/login?invalid=1')
  }

  const supabase = await createClient()
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const proto = headerList.get('x-forwarded-proto') ?? 'https'
  const origin = host ? `${proto}://${host}` : ''

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: false,
    },
  })

  if (error) {
    // Logged server-side only. "User not found" must never reach the client.
    console.error('[login] signInWithOtp failed:', error.message)
  }

  redirect('/login/check-email')
}
