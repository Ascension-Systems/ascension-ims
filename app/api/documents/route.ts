import { NextResponse, after } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkRateLimit } from '@/lib/rate-limit'
import { notifyEveryone } from '@/lib/push'

/**
 * POST -> upload a document (admin only). Multipart: `file` plus metadata fields.
 *
 * ADMIN GATE FIRST, before the body is touched, so an unauthenticated or rep caller never gets
 * as far as streaming a file at us. Rate limited per-admin on top.
 *
 * THREE INDEPENDENT CHECKS on the file, because each covers a different lie:
 *   1. Declared Content-Length is capped before we read, so a huge upload is refused early.
 *   2. The actual byte length is re-checked after read (Content-Length can be absent or false).
 *   3. The MIME is validated against an allowlist AND confirmed by MAGIC BYTES — a .exe renamed
 *      to .pdf, or a text/html blob claiming application/pdf, is rejected on its real content.
 *
 * The storage PATH is server-minted from a random UUID, never the client filename, so a name
 * like `../../evil` cannot escape the bucket prefix. Bytes go in through the service role (the
 * only principal allowed to write the bucket besides an admin), and on any DB failure the object
 * is deleted so a half-upload never lingers.
 */

const MAX_BYTES = 26_214_400 // 25 MiB, matches the DB CHECK
const KINDS = new Set(['promotion', 'spec_sheet', 'flyer', 'price_sheet'])
const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Confirm the leading bytes match the claimed type. Returns the accepted MIME or null. */
function sniff(buf: Uint8Array, claimed: string): string | null {
  const startsWith = (sig: number[]) => sig.every((b, i) => buf[i] === b)
  if (claimed === 'application/pdf' && startsWith([0x25, 0x50, 0x44, 0x46])) return claimed // %PDF
  if (claimed === 'image/png' && startsWith([0x89, 0x50, 0x4e, 0x47])) return claimed
  if (claimed === 'image/jpeg' && startsWith([0xff, 0xd8, 0xff])) return claimed
  if (
    claimed === 'image/webp' &&
    startsWith([0x52, 0x49, 0x46, 0x46]) && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  )
    return claimed
  return null
}

export async function POST(request: Request) {
  const admin = await requireAdmin()
  if (!admin.ok) {
    const status = admin.reason === 'NOT_AUTHENTICATED' ? 401 : 403
    return NextResponse.json(
      {
        error: admin.reason,
        message:
          admin.reason === 'NOT_AUTHENTICATED'
            ? 'Sign in to continue.'
            : 'This action requires an admin account.',
      },
      { status },
    )
  }

  const rl = checkRateLimit('documents:post', admin.profile.id, 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many uploads. Wait a minute and try again.' },
      { status: 429 },
    )
  }

  // Require Content-Length and cap it BEFORE reading. Without this, a chunked/header-less body
  // has declared=0, sails past the check, and formData() buffers the whole thing into memory
  // before file.size is known. Browser FormData uploads always set this header, so requiring it
  // costs our own client nothing while closing the memory-DoS path (admin-gated, but no reason
  // to leave it open).
  const clHeader = request.headers.get('content-length')
  const declared = Number(clHeader)
  if (!clHeader || !Number.isFinite(declared) || declared <= 0) {
    return NextResponse.json(
      { error: 'LENGTH_REQUIRED', message: 'A Content-Length header is required for uploads.' },
      { status: 411 },
    )
  }
  if (declared > MAX_BYTES + 8_192) {
    return NextResponse.json(
      { error: 'PAYLOAD_TOO_LARGE', message: 'That file is larger than the 25 MB limit.' },
      { status: 413 },
    )
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a form upload.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Attach a file to upload.' }, { status: 400 })
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'PAYLOAD_TOO_LARGE', message: 'That file is empty or larger than the 25 MB limit.' },
      { status: 413 },
    )
  }

  const claimed = file.type
  if (!EXT[claimed]) {
    return NextResponse.json(
      { error: 'UNSUPPORTED_TYPE', message: 'Upload a PDF, PNG, JPG or WebP file.' },
      { status: 415 },
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json(
      { error: 'PAYLOAD_TOO_LARGE', message: 'That file is larger than the 25 MB limit.' },
      { status: 413 },
    )
  }
  const mime = sniff(bytes, claimed)
  if (!mime) {
    return NextResponse.json(
      { error: 'UNSUPPORTED_TYPE', message: 'That file’s contents do not match its type.' },
      { status: 415 },
    )
  }

  const kind = String(form.get('kind') ?? '')
  if (!KINDS.has(kind)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Choose a valid document type.' }, { status: 400 })
  }

  const title = String(form.get('title') ?? '').trim()
  if (title.length < 1 || title.length > 200) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Give the document a title.' }, { status: 400 })
  }

  const descriptionRaw = String(form.get('description') ?? '').trim()
  if (descriptionRaw.length > 1000) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Description is too long.' }, { status: 400 })
  }
  const description = descriptionRaw || null

  const skuRaw = String(form.get('product_sku') ?? '').trim()
  const product_sku = skuRaw || null

  const parseDate = (v: FormDataEntryValue | null): string | null | undefined => {
    const s = String(v ?? '').trim()
    if (!s) return null
    const t = Date.parse(s)
    return Number.isNaN(t) ? undefined : new Date(t).toISOString()
  }
  const starts_at = parseDate(form.get('starts_at'))
  const ends_at = parseDate(form.get('ends_at'))
  if (starts_at === undefined || ends_at === undefined) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Dates are not valid.' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const path = `${kind}/${globalThis.crypto.randomUUID()}.${EXT[mime]}`

  const up = await supabase.storage.from('documents').upload(path, bytes, {
    contentType: mime,
    upsert: false,
  })
  if (up.error) {
    console.error('[documents] upload failed:', up.error.message)
    return NextResponse.json({ error: 'UPLOAD_FAILED', message: 'Upload failed. Try again.' }, { status: 502 })
  }

  const insert = await supabase
    .from('documents')
    .insert({
      kind,
      title,
      description,
      product_sku,
      storage_path: path,
      mime_type: mime,
      size_bytes: bytes.length,
      starts_at,
      ends_at,
      uploaded_by: admin.profile.id,
    })
    .select('id')
    .single()

  if (insert.error) {
    // Never leave an orphaned object behind a failed row.
    await supabase.storage.from('documents').remove([path]).catch(() => {})
    // A bad product_sku is the one client-fixable case; keep it distinct.
    const isFk = insert.error.code === '23503'
    console.error('[documents] insert failed:', insert.error.code, insert.error.message)
    return NextResponse.json(
      {
        error: isFk ? 'INVALID_INPUT' : 'INSERT_FAILED',
        message: isFk ? 'That product SKU does not exist.' : 'Could not save the document.',
      },
      { status: isFk ? 400 : 500 },
    )
  }

  // New sales material is broadcast news — every rep hears, promos loudest. after() so the
  // fleet-wide fan-out runs AFTER the 201: a slow APNs can't make the admin's upload appear to
  // fail (and have them re-upload a duplicate). Fail-silent; the upload is already committed.
  const docId = insert.data.id
  after(() =>
    notifyEveryone(
      {
        // KINDS is ['promotion','spec_sheet','flyer','price_sheet'] — this compared against
        // 'promo', which never matches, so every promotion announced itself as "New resource".
        title: kind === 'promotion' ? 'New promotion' : 'New resource',
        body: title,
        url: '/resources',
      },
      admin.profile.id,
    ),
  )

  return NextResponse.json({ ok: true, id: docId }, { status: 201 })
}
