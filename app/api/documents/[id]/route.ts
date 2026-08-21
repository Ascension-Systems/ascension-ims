import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Admin management of one document.
 *   DELETE -> remove the row AND its stored file.
 *   PATCH  -> toggle `active` (hide/show for reps) without deleting.
 *
 * Admin gate first. Writes go through the service role, but the RLS admin-write policy is the
 * real floor: a rep calling these directly is refused at the database even if this code changed.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function guard() {
  const admin = await requireAdmin()
  if (admin.ok) return null
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

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard()
  if (denied) return denied

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Unknown document.' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const { data: row, error } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: 'LOOKUP_FAILED', message: 'Could not remove the document.' }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'That document no longer exists.' }, { status: 404 })
  }

  const del = await supabase.from('documents').delete().eq('id', id)
  if (del.error) {
    return NextResponse.json({ error: 'DELETE_FAILED', message: 'Could not remove the document.' }, { status: 500 })
  }
  // Best-effort object cleanup; the row is already gone so the file is unreachable regardless.
  await supabase.storage.from('documents').remove([row.storage_path as string]).catch(() => {})

  return NextResponse.json({ ok: true }, { status: 200 })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard()
  if (denied) return denied

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Unknown document.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }
  const active = (body as { active?: unknown })?.active
  if (typeof active !== 'boolean') {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Nothing to update.' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const upd = await supabase.from('documents').update({ active }).eq('id', id).select('id').maybeSingle()
  if (upd.error) {
    return NextResponse.json({ error: 'UPDATE_FAILED', message: 'Could not update the document.' }, { status: 500 })
  }
  if (!upd.data) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'That document no longer exists.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, active }, { status: 200 })
}
