'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { after } from 'next/server'
import { checkRateLimit, clientIpKey } from '@/lib/rate-limit'
import { notifyUsers } from '@/lib/push'

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
 * RATE LIMITED on TWO axes, both before the auth server is touched:
 *   1. Per-IP + a global ceiling (lib/rate-limit.ts) — bounds ONE source, but a single serverless
 *      instance's memory only, and the key is a source IP, so a distributed brute-force against
 *      one known account (info@kyriesystems.com) slips under it.
 *   2. Per-EMAIL lockout (0019_login_lockout.sql) — a DB-backed counter shared across every
 *      instance, so N failures against ONE account lock it regardless of how many IPs spread them.
 *   Both run; neither replaces the other.
 *
 * The per-email path runs under the SERVICE-ROLE client because login_attempts is RLS-locked to
 * service_role. It is deliberately FAIL-OPEN: any error from the limiter is logged and swallowed
 * so a DB hiccup slows the hardening but can never lock every account out — availability wins over
 * this one control. It also NEVER branches user-visible behaviour on whether the email exists: a
 * locked email returns the same generic 'rate' redirect as the IP limiter, so this adds no
 * account-existence oracle.
 *
 * redirect() throws NEXT_REDIRECT, so every redirect() below stays out of any try/catch --
 * signInWithPassword returns an { error }, it does not throw, so no try is needed for it.
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

  // Per-account lockout, checked BEFORE the auth server is touched. Fail-open: a limiter error
  // must not block a legitimate sign-in. Same generic 'rate' message as the IP limiter, so a
  // locked known-good address and any other email are indistinguishable to the caller.
  const admin = createAdminClient()
  let locked = false
  try {
    const { data, error } = await admin.rpc('is_login_locked', { p_email: email })
    if (error) {
      console.error('[login] is_login_locked failed (failing open):', error.code, error.message)
    } else {
      locked = data != null
    }
  } catch (e) {
    console.error('[login] is_login_locked threw (failing open):', e)
  }
  if (locked) {
    redirect('/login?error=rate')
  }

  const supabase = await createClient()
  const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // Logged server-side; the caller gets one generic message either way.
    console.error('[login] signInWithPassword failed:', error.status, error.message)
    // Record the failure against the submitted email. Fail-open, and tracked whether or not the
    // account exists so this can't be used to probe which addresses are real.
    try {
      const { error: regError } = await admin.rpc('register_login_failure', { p_email: email })
      if (regError) {
        console.error('[login] register_login_failure failed:', regError.code, regError.message)
      }
    } catch (e) {
      console.error('[login] register_login_failure threw:', e)
    }
    redirect('/login?error=bad')
  }

  // Success: clear the failure counter for this email. Fail-open — a clear that doesn't land
  // just leaves a stale count that the window will expire on its own.
  try {
    const { error: clearError } = await admin.rpc('clear_login_failures', { p_email: email })
    if (clearError) {
      console.error('[login] clear_login_failures failed:', clearError.code, clearError.message)
    }
  } catch (e) {
    console.error('[login] clear_login_failures threw:', e)
  }

  // Security notice to the account's registered devices. If it was you, it's a shrug; if it
  // wasn't, it's the fastest possible tell. The user id comes from the sign-in result (no extra
  // getUser round trip), and after() runs the push past the redirect so it never delays sign-in.
  const signedInId = signInData.user?.id
  if (signedInId) {
    after(() =>
      notifyUsers([signedInId], {
        title: 'New sign-in',
        body: 'Your account just signed in. If this was you, ignore this.',
        url: '/inventory',
      }),
    )
  }

  redirect('/inventory')
}
