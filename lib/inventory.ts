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
  return { rows: (data ?? []) as InventoryViewRow[], error: null }
}

/** The distinct category list, derived rather than queried separately. */
export function categoriesOf(rows: InventoryViewRow[]): string[] {
  return [...new Set(rows.map((r) => r.category))].sort()
}
