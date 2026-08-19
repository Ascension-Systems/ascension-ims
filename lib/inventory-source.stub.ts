import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { InventoryRow, InventorySource } from '@/lib/inventory-source'

/**
 * The QuickBooks stub.
 *
 * It reads the current source-of-record rows and returns them unchanged. It is DELIBERATELY
 * BORING: it stands in for "QuickBooks said the same thing again", which is precisely the
 * stale-baseline condition attack 3 needs.
 *
 * It does NOT invent drift, jitter, or random movement. A stub that changes numbers by itself
 * makes every test non-deterministic and would manufacture the appearance of a working
 * integration where there is none.
 *
 * It never claims to be the real integration: rows it produces carry source
 * 'quickbooks_stub', which the UI labels "QuickBooks (stub)". When the real integration lands
 * it writes 'quickbooks' and the change is visible to every rep.
 *
 * Rows already carrying a manual_override are passed through with their own source value.
 * apply_inventory_sync preserves them rather than overwriting -- show both numbers, never
 * silently override.
 */
export function stubInventorySource(): InventorySource {
  return {
    async fetchInventory(): Promise<InventoryRow[]> {
      const admin = createAdminClient()
      const { data, error } = await admin
        .from('inventory')
        .select('sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload')
        .order('sku')

      if (error) {
        throw new Error(`stub inventory source could not read the source-of-record rows: ${error.message}`)
      }

      return (data ?? []).map((row) => ({
        sku: row.sku as string,
        location: (row.location as string) ?? 'default',
        qty_on_hand: row.qty_on_hand as number,
        qty_committed: row.qty_committed as number,
        qty_incoming: row.qty_incoming as number,
        incoming_eta: (row.incoming_eta as string | null) ?? null,
        // An override row keeps its own source. Everything else is stub-sourced, and says so.
        source: row.source === 'manual_override' ? 'manual_override' : 'quickbooks_stub',
        source_payload: (row.source_payload as Record<string, unknown> | null) ?? null,
      }))
    },
  }
}
