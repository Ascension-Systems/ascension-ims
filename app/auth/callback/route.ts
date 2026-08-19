import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Handles BOTH return shapes. Which one arrives depends on the Supabase email template, and
 * getting this wrong produces a link that appears to do nothing:
 *
 *   `code`       PKCE flow (@supabase/ssr default, from {{ .ConfirmationURL }})
 *   `token_hash` templates using {{ .TokenHash }}
 *
 * Switching the template is a dashboard change and is NOT required for this build to work.
 */

/**
 * Open-redirect guard. A `next` parameter is honoured only if it starts with a single `/`.
 * An open redirect on an auth callback is a phishing primitive; do not remove this.
 */
function safeNext(next: string | null): string {
  if (!next) return '/inventory'
  if (!next.startsWith('/')) return '/inventory'
  if (next.startsWith('//') || next.startsWith('/\\')) return '/inventory'
  return next
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = safeNext(searchParams.get('next'))

  const errorUrl = request.nextUrl.clone()
  errorUrl.pathname = '/auth/auth-code-error'
  errorUrl.search = ''

  const supabase = await createClient()

  let failed = true
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    failed = Boolean(error)
  } else if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      type: type ?? 'magiclink',
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

  const destination = request.nextUrl.clone()
  destination.pathname = next
  destination.search = ''
  return NextResponse.redirect(destination)
}
