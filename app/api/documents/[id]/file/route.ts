import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * GET -> a short-lived signed URL to the document's file, then redirect to it.
 *
 * TWO GATES, both on the COOKIE-BOUND client so RLS is the authority:
 *   1. The row is read through the caller's session. `documents_select_provisioned` means an
 *      unprovisioned or anonymous caller reads zero rows -> 404, indistinguishable from a bad id,
 *      so this endpoint cannot confirm which document ids exist.
 *   2. The signed URL is minted through the same session; `documents_obj_read` on the bucket
 *      refuses it unless the caller is provisioned. Service role is never used here, so a bug in
 *      this file cannot widen access beyond what the database already allows.
 *
 * The URL lives 120 seconds: long enough to open, short enough that a leaked link is stale fast.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TTL_SECONDS = 120

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
  }

  // Keyed on the unforgeable user id, so one account cannot hammer this to mint an unbounded
  // stream of signed URLs (storage egress / cost). Generous enough for real human browsing.
  const rl = checkRateLimit('documents:file', user.id, 60, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and try again.' },
      { status: 429 },
    )
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Document not found.' }, { status: 404 })
  }

  const supabase = await createClient()
  const { data: row } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle()
  if (!row) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Document not found.' }, { status: 404 })
  }

  const signed = await supabase.storage
    .from('documents')
    .createSignedUrl(row.storage_path as string, TTL_SECONDS)
  if (signed.error || !signed.data?.signedUrl) {
    console.error('[documents] sign failed:', signed.error?.message)
    return NextResponse.json({ error: 'SIGN_FAILED', message: 'Could not open the document.' }, { status: 502 })
  }

  return NextResponse.redirect(signed.data.signedUrl, 303)
}
