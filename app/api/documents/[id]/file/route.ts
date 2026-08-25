import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * GET -> the document's file, streamed INLINE from this same origin.
 *
 * Why inline-stream rather than redirect to a signed URL: the in-app viewer embeds this in an
 * <iframe>, and a cross-origin redirect to a Supabase signed URL renders unreliably inside a
 * webview (blank/black, especially in the iOS WKWebView shell). Serving the bytes from our own
 * origin with Content-Disposition: inline lets the browser's native PDF/image viewer render it
 * in place, keeping the rep inside the app. Cost: egress flows through this function instead of
 * the Supabase CDN — negligible at pilot scale, and still bounded by the per-user rate limit.
 *
 * TWO GATES, both on the COOKIE-BOUND client so RLS is the authority:
 *   1. The row is read through the caller's session. `documents_select_provisioned` means an
 *      unprovisioned or anonymous caller reads zero rows -> 404, indistinguishable from a bad id,
 *      so this endpoint cannot confirm which document ids exist.
 *   2. The bytes are downloaded through the same session; `documents_obj_read` on the bucket
 *      refuses it unless the caller is provisioned. Service role is never used here, so a bug in
 *      this file cannot widen access beyond what the database already allows.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
  }

  // Keyed on the unforgeable user id, so one account cannot hammer this endpoint. Generous
  // enough for real human browsing of the library.
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

  const path = row.storage_path as string
  const dl = await supabase.storage.from('documents').download(path)
  if (dl.error || !dl.data) {
    console.error('[documents] download failed:', dl.error?.message)
    return NextResponse.json({ error: 'FETCH_FAILED', message: 'Could not open the document.' }, { status: 502 })
  }

  // Trust the extension for the content type over the blob's (Supabase sometimes returns
  // application/octet-stream, which a browser will download rather than render inline).
  const ext = path.split('.').pop()?.toLowerCase()
  const byExt: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  }
  const contentType = (ext && byExt[ext]) || (dl.data.type && dl.data.type !== 'application/octet-stream' ? dl.data.type : 'application/octet-stream')

  return new NextResponse(dl.data.stream(), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300, stale-while-revalidate=86400',
      'x-content-type-options': 'nosniff',
    },
  })
}
