/**
 * THE ADAPTER. One module, one function signature.
 *
 * Nothing else in the app knows which source is in use. At QuickBooks cutover,
 * getInventorySource() returns a Conductor-backed implementation and NOTHING ELSE IN THE
 * REPO CHANGES -- not the schema, not the view, not a component, not a query. That is the
 * contract, and it is the reason for the three stub rules:
 *
 *   1. Store the components (on_hand, committed, incoming), derive `available`. Never store
 *      a single blended quantity -- the real fields would have nowhere to land.
 *   2. Model the location dimension from day one. The stub writes location = 'default'.
 *   3. One adapter module, one function signature. This file.
 *
 * Stated honestly: this contract is a guess. We do not yet know the client's QuickBooks
 * edition, whether they use Advanced Inventory, or whether Sales Orders are entered at all.
 * The three rules are what make a wrong guess cheap instead of expensive. Nobody should be
 * told integration is "just a config change" until those questions are answered.
 */

export type InventoryRow = {
  sku: string
  location: string
  qty_on_hand: number
  qty_committed: number
  qty_incoming: number
  /** ISO date, or null. */
  incoming_eta: string | null
  source: 'quickbooks' | 'quickbooks_stub' | 'manual_override'
  source_payload: Record<string, unknown> | null
}

export interface InventorySource {
  fetchInventory(): Promise<InventoryRow[]>
}

/**
 * Returns the stub today. At cutover this returns the Conductor-backed implementation and
 * nothing else changes.
 *
 * The import is dynamic so that lib/inventory-source.stub.ts -- which reaches for the
 * service-role client -- is only ever pulled in on the server, at call time, and never
 * becomes part of a client bundle through this module.
 */
export function getInventorySource(): InventorySource {
  return {
    async fetchInventory() {
      const { stubInventorySource } = await import('@/lib/inventory-source.stub')
      return stubInventorySource().fetchInventory()
    },
  }
}
