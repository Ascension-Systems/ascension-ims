import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'

/**
 * Handles BOTH return shapes. Which one arrives depends on the Supabase email template, and
 * getting this wrong produces a link that appears to do nothing:
 *
 *   `code`       PKCE flow (@supabase/ssr default, from {{ .ConfirmationURL }})
 *   `token_hash` templates using {{ .TokenHash }}
 *
 * Switching the template is a dashboard change and is NOT required for this build to work.
 *
 * ------------------------------------------------------------------------------------
 * OUTBOUND REDIRECT ORIGINS COME FROM CONFIGURATION, NOT FROM THE REQUEST.
 * ------------------------------------------------------------------------------------
 * Both redirects below used to be built with `request.nextUrl.clone()`. `request.nextUrl` is
 * derived from the request's host header, which an attacker sets, so both carried the same
 * host-header-poisoning defect as the magic-link origin in `app/login/actions.ts`. They now
 * resolve against `NEXT_PUBLIC_SITE_URL` via `lib/env.ts`.
 *
 * `searchParams` are still read from `request.nextUrl` and that is correct — the query string
 * is the payload this route exists to consume. Only the ORIGIN of outbound redirects moved.
 */

/**
 * Open-redirect guard. A `next` parameter is honoured only if it starts with a single `/`.
 * An open redirect on an auth callback is a phishing primitive; do not remove this.
 *
 * It is now belt-and-braces — `new URL(next, site)` cannot escape `site` once `next` is known
 * to start with a single `/` — but deleting a working guard on a hardening pass is a
 * regression, not a simplification.
 */
function safeNext(next: string | null): string {
  if (!next) return '/inventory'
  if (!next.startsWith('/')) return '/inventory'
  if (next.startsWith('//') || next.startsWith('/\\')) return '/inventory'
  return next
}

/**
 * `type` arrives in the query string and is attacker-controlled. Casting it to EmailOtpType
 * is a cast, not a check. The two excluded values are the dangerous ones: `recovery` drives a
 * password-reset verification and this project has no passwords at all (README step 4), and
 * `email_change` verification MUTATES the user's email address. Neither flow exists anywhere
 * in this build, so excluding them cannot break anything, and including them would let an
 * attacker steer a token into a verification intent the app never issues.
 *
 * `signup` and `invite` are retained because the Human provisions users through the dashboard
 * (README step 4) and either shape can legitimately arrive.
 */
const ALLOWED_OTP_TYPES = ['magiclink', 'signup', 'invite', 'email'] as const

type AllowedOtpType = (typeof ALLOWED_OTP_TYPES)[number]

function isAllowedOtpType(value: string): value is AllowedOtpType {
  return (ALLOWED_OTP_TYPES as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  // Resolved ONCE, before anything else, and fail-closed. A redirect built from the request
  // would defeat the fix, so there is no error redirect on this path at all — a plain 500 and
  // a server log, which cannot be mistaken for success.
  let site: string
  try {
    site = siteUrl()
  } catch (err) {
    console.error(
      '[auth/callback] NEXT_PUBLIC_SITE_URL is not configured:',
      err instanceof Error ? err.message : String(err),
    )
    return new NextResponse('Auth callback is not configured. See server logs.', { status: 500 })
  }

  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const rawType = searchParams.get('type')
  const next = safeNext(searchParams.get('next'))

  const errorUrl = new URL('/auth/auth-code-error', site)

  // Absent `type` defaults to 'magiclink' — required by {{ .TokenHash }} templates, which omit
  // it. Present and in the allow-list: used. Present and outside it: verifyOtp is NOT called.
  let type: EmailOtpType = 'magiclink'
  if (rawType !== null) {
    if (!isAllowedOtpType(rawType)) {
      console.error('[auth/callback] rejected out-of-allow-list otp type:', JSON.stringify(rawType))
      return NextResponse.redirect(errorUrl)
    }
    type = rawType
  }

  const supabase = await createClient()

  let failed = true
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    failed = Boolean(error)
  } else if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    })
    failed = Boolean(error)
  }

  if (failed) {
    return NextResponse.redirect(errorUrl)
  }

  // The trigger fallback (migration 0002). Idempotent and cheap; it means a refused trigger
  // on auth.users does not produce a signed-in user with no profile row. It CANNOT downgrade
  // an existing admin -- it is ON CONFLICT DO NOTHING and never DO UPDATE.
  const { error: profileError } = await supabase.rpc('ensure_profile')
  if (profileError) {
    console.error('[auth/callback] ensure_profile failed:', profileError.message)
  }

  const destination = new URL(next, site)
  return NextResponse.redirect(destination)
}
