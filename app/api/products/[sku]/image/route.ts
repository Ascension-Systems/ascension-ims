import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * GET -> streams a product photo INLINE, same-origin.
 *
 * Mirrors app/api/documents/[id]/file: the bytes come back through our own origin rather than
 * as a redirect to a signed storage URL, because a cross-origin redirect renders blank inside
 * the iOS WKWebView. Auth and RLS are enforced on the way through — the cookie-bound client is
 * used, never the service-role client, so the `product_images_read` policy (0023) decides.
 *
 * Photos are catalogue data, not per-rep data, so any provisioned user may read one. They are
 * still not public: an unauthenticated request gets a 401 from the middleware before arriving.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ sku: string }> }) {
  const { sku } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 })
  }

  const rl = checkRateLimit('product:image', user.id, 300, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })
  }

  // The stored path, read under RLS. An unknown sku and a forbidden one both end as 404.
  const { data: product } = await supabase
    .from('products')
    .select('image_path')
    .eq('sku', sku)
    .maybeSingle()

  const path = product?.image_path as string | null | undefined
  if (!path) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  const dl = await supabase.storage.from('product-images').download(path)
  if (dl.error || !dl.data) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  return new NextResponse(dl.data.stream() as unknown as BodyInit, {
    headers: {
      'content-type': 'image/jpeg',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      // Catalogue imagery is stable and re-fetched constantly while scrolling; a private cache
      // keeps a rep on a phone from re-downloading every thumbnail on each render.
      'cache-control': 'private, max-age=3600',
    },
  })
}
