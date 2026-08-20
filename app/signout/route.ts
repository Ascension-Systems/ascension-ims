import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'

/**
 * POST ONLY. A GET sign-out is CSRF-able and gets triggered by link prefetchers, which
 * signs users out at apparently random moments.
 *
 * The redirect origin comes from configuration (siteUrl()), never from the request host. A
 * host-header-derived redirect is an open-redirect primitive; every other redirect in this
 * app was moved to the config origin for that reason, and this one now matches. Sign-out
 * happens BEFORE siteUrl() is resolved, so the session is destroyed even if the origin is
 * misconfigured — fail-closed on the security action, fail-loud on the redirect.
 */
export async function POST() {
  const supabase = await createClient()
  await supabase.auth.signOut()

  let site: string
  try {
    site = siteUrl()
  } catch (err) {
    console.error(
      '[signout] NEXT_PUBLIC_SITE_URL is not configured:',
      err instanceof Error ? err.message : String(err),
    )
    return new NextResponse('Sign-out redirect is not configured. See server logs.', {
      status: 500,
    })
  }
  return NextResponse.redirect(new URL('/login', site), { status: 303 })
}
