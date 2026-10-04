import { createClient } from '@/lib/supabase/server'
import type { AppSettings } from '@/lib/types'

/**
 * Reads the app_settings singleton.
 *
 * `stale_after_minutes` and `low_stock_default` live in the database rather than in code so
 * they are tunable without a redeploy. (`inventory_authority` still exists as a column but is
 * pinned to 'quickbooks' by 0025 and no longer read: QuickBooks is the only source.)
 */
const FALLBACK: AppSettings = {
  low_stock_default: 5,
  stale_after_minutes: 360,
}

export async function getSettings(): Promise<AppSettings> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('app_settings')
    .select('low_stock_default, stale_after_minutes')
    .maybeSingle()

  // Fall back to the shipping defaults rather than failing the page.
  return (data as AppSettings | null) ?? FALLBACK
}
