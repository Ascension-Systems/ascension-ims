import { createClient } from '@/lib/supabase/server'
import type { InventoryViewRow } from '@/lib/types'

/**
 * Typed reads over v_inventory.
 *
 * Uses the COOKIE-BOUND ANON CLIENT, never the service-role client, so the page is subject
 * to RLS. A policy bug therefore shows up as missing data rather than as a silent leak.
 *
 * Fetches ALL rows and lets the client filter. The catalogue is ~97 rows / ~30KB of JSON; a
 * round trip per keystroke on a phone with poor signal is worse than every alternative and
 * makes search feel broken in exactly the conditions this app is used in. Revisit above
 * ~2,000 rows.
 */
export async function getInventory(): Promise<{ rows: InventoryViewRow[]; error: string | null }> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('v_inventory').select('*').order('name')

  if (error) {
    return { rows: [], error: error.message }
  }
  const rows = (data ?? []) as InventoryViewRow[]

  // Photo + website link live on `products` (0023); v_inventory predates them. Merging here
  // avoids reshaping the view — which owns the availability maths — for two display fields.
  // One extra round trip over the same ~97 rows, and a failure degrades to "no photo, no link"
  // rather than losing the inventory itself.
  const { data: extras } = await supabase.from('products').select('sku, image_path, product_url')
  if (extras?.length) {
    const bySku = new Map(extras.map((e) => [e.sku as string, e]))
    for (const row of rows) {
      const extra = bySku.get(row.sku)
      row.image_path = (extra?.image_path as string | null) ?? null
      row.product_url = (extra?.product_url as string | null) ?? null
    }
  }
  return { rows, error: null }
}

/** The distinct category list, derived rather than queried separately. */
export function categoriesOf(rows: InventoryViewRow[]): string[] {
  return [...new Set(rows.map((r) => r.category))].sort()
}
