'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'

/**
 * Email + password sign-in.
 *
 * Passwords, not magic links: a field rep expects to type an email and a password, and the
 * link-in-your-inbox flow depended on email delivery that was never going to be reliable at
 * this scale. The password is set once during onboarding (/join), with the access code.
 *
 * ONE GENERIC FAILURE MESSAGE. "No such account" and "wrong password" return the same thing,
 * so this form cannot be used to discover which email addresses have accounts.
 *
 * RATE LIMITED, because a password form is brute-forceable in a way a magic-link request is
 * not. Per-IP and a global ceiling, both before the auth server is touched. Real per-account
 * lockout is a fast-follow; for a pilot the limiter plus a strong password is the right floor.
 *
 * redirect() throws NEXT_REDIRECT, so every redirect() below stays out of any try/catch --
 * signInWithPassword returns an { error }, it does not throw, so no try is needed at all.
 */
export async function signIn(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')

  const requestHeaders = await headers()
  const ip = checkRateLimit('login:password', clientIpKey(requestHeaders), 10, 60_000)
  const global = checkRateLimit('login:password:global', 'all', 200, 60_000)
  if (!ip.allowed || !global.allowed) {
    redirect('/login?error=rate')
  }

  if (!email || !password) {
    redirect('/login?error=missing')
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // Logged server-side; the caller gets one generic message either way.
    console.error('[login] signInWithPassword failed:', error.status, error.message)
    redirect('/login?error=bad')
  }

  redirect('/inventory')
}
