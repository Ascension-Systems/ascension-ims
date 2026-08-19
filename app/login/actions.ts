'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'
import {
  classifyAuthError,
  LOGIN_ERROR,
  UNCLASSIFIED_REASON,
  type AuthFailureClass,
} from './auth-error'

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
 *
 * ------------------------------------------------------------------------------------
 * THE PART THAT WAS A DEFECT, AND WHAT REPLACED IT
 * ------------------------------------------------------------------------------------
 * This action used to log EVERY error class and then redirect to /login/check-email
 * regardless. With a wrong or rotated anon key, or during a Supabase incident, all ~120 reps
 * saw "check your email", no email arrived, and the portal looked healthy. A silent failure
 * dressed as a security property.
 *
 * The security property is real and survives intact — but it only ever applied to
 * ADDRESS-SPECIFIC conditions. "This address is not registered" must not be disclosed;
 * "our auth provider is down" is not about the address at all, and hiding it protects nobody.
 * So the error is classified (`./auth-error.ts`, which branches on `status` and `code` and
 * NEVER on message text) into exactly three outcomes:
 *
 *   SUPPRESSED    address-specific -> the SAME /login/check-email page as success, byte for
 *                 byte, from the SAME redirect call site below. Server-side log only.
 *   RATE_LIMITED  -> /login?error=rate_limited. See the open question in auth-error.ts.
 *   UNAVAILABLE   everything else, INCLUDING everything unrecognised -> /login?error=unavailable
 *
 * The default is UNAVAILABLE. An error shape nobody has seen yet fails honestly rather than
 * being reported as a sent email. That default is the fix; do not narrow it.
 *
 * The user-facing copy for UNAVAILABLE says the problem is not with the address, precisely so
 * that the infrastructure branch de-correlates itself from registration status and reveals
 * nothing an attacker can use.
 *
 * ------------------------------------------------------------------------------------
 * THE REDIRECT ORIGIN IS CONFIGURATION, NOT A HEADER.
 * ------------------------------------------------------------------------------------
 * `emailRedirectTo` used to be built from `x-forwarded-host` / `host`, which an attacker sets.
 * A login request submitted for a VICTIM'S address with a forged host header would send the
 * victim a magic link pointing at the attacker's origin; clicking it hands over the auth
 * `code`, which is account takeover. The victim does nothing wrong and sees nothing unusual.
 *
 * It is now `NEXT_PUBLIC_SITE_URL`, read and validated through `lib/env.ts`. DO NOT
 * REINTRODUCE A HEADER FALLBACK "FOR PREVIEWS" — that is the whole defect. A preview
 * deployment sets its own NEXT_PUBLIC_SITE_URL.
 *
 * The Supabase Redirect URL allow-list (README step 3b) still matters and is still required,
 * but it is now defence in depth rather than the only control in front of this path.
 */
export async function requestMagicLink(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()

  // Shape check only. Never tell the caller whether the address is registered.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect('/login?invalid=1')
  }

  // SUCCESS and SUPPRESSED are different facts with one identical response.
  type Outcome = 'SUCCESS' | AuthFailureClass

  // Fail-safe default. If nothing below runs, we fail honestly rather than claiming success.
  let outcome: Outcome = 'UNAVAILABLE'
  let reason: string = UNCLASSIFIED_REASON

  try {
    // createClient() THROWS when a required env var is missing (lib/env.ts). It belongs
    // inside the try so a blank or wrong environment produces the honest error page instead
    // of a framework error screen.
    //
    // siteUrl() is in here for the SAME reason, and that placement is load-bearing. It throws
    // when NEXT_PUBLIC_SITE_URL is unset or malformed; the throw lands in the catch below,
    // becomes `unavailable:threw`, and the user gets /login?error=unavailable while the server
    // log carries "Missing environment variable NEXT_PUBLIC_SITE_URL...". Fail-closed and
    // loud, with no new machinery. There is NO fallback to a request header, under any
    // condition — see the note above.
    const supabase = await createClient()
    const origin = siteUrl()

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin}/auth/callback`,
        shouldCreateUser: false,
      },
    })

    if (!error) {
      outcome = 'SUCCESS'
      reason = 'ok'
    } else {
      const classified = classifyAuthError(error)
      outcome = classified.klass
      reason = classified.reason
      // Logged server-side only. "User not found" must never reach the client.
      console.error('[login] signInWithOtp failed:', reason, error.message)
      if (classified.reason === UNCLASSIFIED_REASON) {
        // A distinct, greppable marker. This is the branch the Human's ruling on the UNAVAILABLE
        // default makes load-bearing, so it must be findable without reading every login line.
        console.error(
          'UNCLASSIFIED_AUTH_ERROR [login] signInWithOtp: the auth error matched no known status or ' +
            'code branch and was classified UNAVAILABLE by default. ' +
            `status=${JSON.stringify(error.status)} code=${JSON.stringify(error.code)} ` +
            `name=${JSON.stringify(error.name)}`,
        )
      }
    }
  } catch (thrown) {
    outcome = 'UNAVAILABLE'
    reason = 'unavailable:threw'
    console.error(
      '[login] signInWithOtp threw:',
      thrown instanceof Error ? thrown.message : String(thrown),
    )
  }

  // redirect() works by THROWING NEXT_REDIRECT. Every redirect() call must stay outside the
  // try above, or the catch swallows it and the action falls through. This is the single most
  // likely way to break this fix. There are exactly three redirect targets in this file and
  // assertion 5.4 depends on there being no fourth.
  if (outcome === 'RATE_LIMITED') redirect(`/login?error=${LOGIN_ERROR.RATE_LIMITED}`)
  if (outcome === 'UNAVAILABLE') redirect(`/login?error=${LOGIN_ERROR.UNAVAILABLE}`)

  // SUCCESS and SUPPRESSED share ONE call site, deliberately. One call site is a structural
  // guarantee that the registered and unregistered responses can never drift apart; two
  // identical redirects would be a future bug waiting for someone to edit one of them.
  redirect('/login/check-email')
}
