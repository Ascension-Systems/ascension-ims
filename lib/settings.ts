import { createClient } from '@/lib/supabase/server'
import type { AppSettings } from '@/lib/types'

/**
 * Reads the app_settings singleton.
 *
 * `stale_after_minutes` and `low_stock_default` live in the database rather than in code so
 * they are tunable without a redeploy, and `inventory_authority` is flipped by a one-row
 * UPDATE by an admin -- no deploy, no code change, no second rendering path.
 */
const FALLBACK: AppSettings = {
  inventory_authority: 'quickbooks',
  low_stock_default: 5,
  stale_after_minutes: 360,
}

export async function getSettings(): Promise<AppSettings> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('app_settings')
    .select('inventory_authority, low_stock_default, stale_after_minutes')
    .maybeSingle()

  // Fall back to the shipping defaults rather than failing the page. The conservative
  // default is 'quickbooks' -- show both numbers, never silently override.
  return (data as AppSettings | null) ?? FALLBACK
}
