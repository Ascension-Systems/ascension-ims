/** Shared row and DTO types. Mirrors the shapes migrations 0001-0008 produce. */

export type AppRole = 'rep' | 'admin'

export type CommitmentState = 'pending' | 'confirmed_in_source' | 'retired'

export type InventorySourceName = 'quickbooks' | 'quickbooks_stub' | 'manual_override'

export type InventoryAuthority = 'quickbooks' | 'portal'

export type Profile = {
  id: string
  email: string
  role: AppRole
  created_at: string
}

export type AppSettings = {
  inventory_authority: InventoryAuthority
  low_stock_default: number
  stale_after_minutes: number
}

/** One row of public.v_inventory. */
export type InventoryViewRow = {
  sku: string
  name: string
  category: string
  uom: string
  low_stock_threshold: number
  location: string
  qty_on_hand: number
  /** Committed per the source (QuickBooks). */
  qty_committed_source: number
  /** Sum of `pending` portal commitments. The advisory delta. */
  qty_committed_portal: number
  qty_committed_total: number
  /** on_hand - committed_source. Primary figure in `quickbooks` mode. */
  qty_available_source: number
  /**
   * on_hand - committed_source - committed_portal. Primary figure in `portal` mode, and
   * ALWAYS the figure the status badge is computed from. Never clamped at zero: a negative
   * value means the source dropped on-hand below what is already spoken for, which is
   * exactly the condition a rep needs to see.
   */
  qty_available: number
  qty_incoming: number
  incoming_eta: string | null
  source: InventorySourceName
  override_note: string | null
  override_at: string | null
  override_by: string | null
  updated_at: string
  /**
   * Catalogue extras joined in by lib/inventory.ts rather than exposed by v_inventory.
   *
   * They live on `products` (migration 0023) and the view predates them; merging in the app
   * layer keeps the view — and the availability maths it owns — untouched. Both are optional
   * because a product may legitimately have neither: not everything the client sells is
   * photographed, and Levon flagged that not everything is published on their website.
   */
  image_path?: string | null
  product_url?: string | null
}
