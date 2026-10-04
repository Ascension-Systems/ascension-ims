import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { getInventorySource } from '@/lib/inventory-source'
import { mapPostgresError } from '@/lib/errors'

/**
 * POST -> adapter + apply_inventory_sync. Admin only. Applies the source's rows: on hand,
 * committed (QuickBooks open sales orders — the only source of committed since 0025) and
 * incoming.
 *
 * TWO LAYERS OF ROLE ENFORCEMENT, and the database one is authoritative:
 *
 *   1. requireAdmin() here, so a rep gets a clean 403 rather than a 500.
 *   2. The is_admin() guard INSIDE apply_inventory_sync (a SECURITY DEFINER function).
 *
 * Attack 4 bypasses this handler entirely and calls the function directly, to prove layer 2
 * is real. Hiding a button is not access control and this guard is not it either.
 */
export async function POST() {
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

  let rows
  try {
    rows = await getInventorySource().fetchInventory()
  } catch (err) {
    console.error('[api/sync] inventory source failed:', err)
    return NextResponse.json(
      { error: 'INTERNAL', message: 'The inventory source could not be read.' },
      { status: 502 },
    )
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('apply_inventory_sync', {
    p_payload: { rows },
  })

  if (error) {
    const mapped = mapPostgresError(error)
    if (mapped.status === 500) {
      console.error('[api/sync] unmapped database error:', error.code, error.message)
    }
    return NextResponse.json({ error: mapped.error, message: mapped.message }, { status: mapped.status })
  }

  return NextResponse.json({ run: data }, { status: 200 })
}
