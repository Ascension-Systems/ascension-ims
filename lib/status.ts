/**
 * Stock-status and staleness derivation. Pure, unit-testable, no ambient clock.
 *
 * THE STATUS BADGE IS COMPUTED FROM `qty_available` -- on hand minus QuickBooks' committed
 * (open sales orders), the figure a rep acts on. Since 0025 QuickBooks is the only source of
 * committed; the portal records no commitments of its own.
 */

import type { InventorySourceName, InventoryViewRow } from '@/lib/types'
import { ageInMinutes } from '@/lib/relative-time'

export type StockStatus = 'in-stock' | 'low' | 'none-incoming' | 'none'

/**
 * The multi-channel encoding, as data.
 *
 * D2 restricts the palette to white, grays and black, which makes the brief's "not by colour
 * alone" requirement binding rather than optional -- and with an achromatic palette it also
 * cannot be carried by LIGHTNESS alone. "The darker one" fails the requirement the same way
 * a red/green pair would.
 *
 * So every pair of statuses differs on AT LEAST THREE channels:
 *
 *   glyph silhouette   square / triangle / down-arrow-in-dashed-circle / slashed circle
 *   border style       solid / solid / dashed / dotted
 *   fill weight        solid-inverted / outlined / outlined / outlined + hatch
 *   left rule          full-height solid / half-height solid / full-height dashed / dotted
 *   label text         always rendered, never icon-only, at any breakpoint
 *
 * Remove colour AND lightness entirely and all four remain distinguishable. That is the test
 * to apply while writing the CSS, not something to check afterwards.
 */
export type StatusEncoding = {
  status: StockStatus
  /** Always rendered. An icon alone is never sufficient. */
  label: string
  /** Which glyph in components/icons.tsx to draw. */
  glyph: 'square' | 'triangle' | 'arrow-down' | 'slashed-circle'
  /** CSS module class suffix, e.g. `badgeInStock`. */
  variant: 'InStock' | 'Low' | 'NoneIncoming' | 'None'
  /** Spoken/assistive description, used for the accessible name. */
  description: string
}

const ENCODINGS: Record<StockStatus, StatusEncoding> = {
  'in-stock': {
    status: 'in-stock',
    label: 'IN STOCK',
    glyph: 'square',
    variant: 'InStock',
    description: 'In stock',
  },
  low: {
    status: 'low',
    label: 'LOW',
    glyph: 'triangle',
    variant: 'Low',
    description: 'Low stock',
  },
  'none-incoming': {
    status: 'none-incoming',
    label: 'NONE — INCOMING',
    glyph: 'arrow-down',
    variant: 'NoneIncoming',
    description: 'None available, stock incoming',
  },
  none: {
    status: 'none',
    label: 'NONE AVAILABLE',
    glyph: 'slashed-circle',
    variant: 'None',
    description: 'None available',
  },
}

/**
 * Derives stock status from the conservative availability figure.
 *
 * The `available <= 0` branches are tested FIRST so that a negative availability -- which is
 * real information, never clamped -- lands on a "none" status rather than falling through.
 */
export function stockStatus(
  qtyAvailable: number,
  lowStockThreshold: number,
  qtyIncoming: number,
): StockStatus {
  if (qtyAvailable <= 0) return qtyIncoming > 0 ? 'none-incoming' : 'none'
  if (qtyAvailable < lowStockThreshold) return 'low'
  return 'in-stock'
}

export function statusEncoding(status: StockStatus): StatusEncoding {
  return ENCODINGS[status]
}

export function rowStatus(row: InventoryViewRow): StatusEncoding {
  return ENCODINGS[stockStatus(row.qty_available, row.low_stock_threshold, row.qty_incoming)]
}

/**
 * Freshness is ORTHOGONAL to stock status and is rendered as a SECOND badge. An item can be
 * Low and Stale at once, and collapsing those onto one scale would hide one of them.
 */
export function isStale(updatedAt: string, now: number, staleAfterMinutes: number): boolean {
  return ageInMinutes(updatedAt, now) > staleAfterMinutes
}

/** Human label for the source column. The stub must never claim to be the real integration. */
export function sourceLabel(source: InventorySourceName): string {
  switch (source) {
    case 'quickbooks':
      return 'QuickBooks'
    case 'quickbooks_stub':
      return 'QuickBooks (stub)'
    case 'manual_override':
      return 'Manual override'
    default:
      return source
  }
}

/* ------------------------------------------------------------------------- *
 * Availability presentation
 *
 * One mode since 0025: the figure is QuickBooks' availability (on hand minus open sales
 * orders) and the components line always shows both inputs, so nothing is hidden. Returns
 * DATA rather than markup so there is exactly one rendering path.
 * ------------------------------------------------------------------------- */

export type AvailabilityPresentation = {
  /** The large figure. */
  primaryValue: number
  /** Label above the large figure. */
  primaryLabel: string
  /** The components breakdown, always shown. */
  componentsLine: string
}

const units = (n: number, uom: string) => (uom && uom !== 'EA' ? `${n} ${uom}` : `${n}`)

export function availabilityPresentation(row: InventoryViewRow): AvailabilityPresentation {
  // Incoming is one of the five centrepiece figures the brief names, and it is most needed on
  // exactly the item the fixtures stress: available at zero with stock on the way. It rides on
  // the always-shown components line so it is visible on the COLLAPSED card, not only once the
  // row is expanded. Shown only when there is genuinely incoming stock.
  const incoming = row.qty_incoming > 0 ? ` · ${units(row.qty_incoming, row.uom)} incoming` : ''

  return {
    primaryValue: row.qty_available,
    primaryLabel: 'AVAILABLE (QUICKBOOKS)',
    componentsLine: `${units(row.qty_on_hand, row.uom)} on hand · ${row.qty_committed} committed in QuickBooks${incoming}`,
  }
}
