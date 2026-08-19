'use client'

import { AvailabilityBlock, AvailabilityLines } from '@/components/availability-block'
import { StatusBadge } from '@/components/status-badge'
import { StaleBadge } from '@/components/stale-badge'
import { RelativeTime } from '@/components/relative-time'
import { ChevronGlyph } from '@/components/icons'
import { rowStatus, sourceLabel } from '@/lib/status'
import { formatAbsolute, formatRelativeAge } from '@/lib/relative-time'
import type { InventoryAuthority, InventoryViewRow } from '@/lib/types'
import styles from './inventory-row.module.css'

/**
 * One product card.
 *
 * TAP TO EXPAND IN PLACE. There is no detail route: expansion is an in-place accordion, so
 * there is no navigation, no back button and no lost scroll position. That keeps the
 * three-tap budget (chip or search -> row -> read).
 */

function etaLabel(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `ETA ${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

export function InventoryRow({
  row,
  authority,
  stale,
  serverNow,
  expanded,
  onToggle,
  overrideAuthor,
}: {
  row: InventoryViewRow
  authority: InventoryAuthority
  stale: boolean
  serverNow: number
  expanded: boolean
  onToggle: () => void
  /** Resolved email of the override author, or null when the viewer may not read it. */
  overrideAuthor?: string | null
}) {
  const encoding = rowStatus(row)
  const eta = row.qty_incoming > 0 ? etaLabel(row.incoming_eta) : null
  const panelId = `panel-${row.sku}-${row.location}`

  return (
    <li className={`${styles.card} rule${encoding.variant} ${stale ? 'cardStale' : ''}`}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className={styles.identity}>
          <span className={styles.name}>{row.name}</span>
          <span className={styles.sku}>{row.sku}</span>
        </span>

        <AvailabilityBlock row={row} authority={authority} encoding={encoding} />

        <ChevronGlyph className={styles.chevron} expanded={expanded} />
      </button>

      <div className={styles.badges}>
        {/* Stock status first in document order, so it is announced first. */}
        <StatusBadge encoding={encoding} etaLabel={eta} />
        {stale ? <StaleBadge ageLabel={formatRelativeAge(row.updated_at, serverNow)} /> : null}
      </div>

      <AvailabilityLines row={row} authority={authority} />

      <p className={styles.meta}>
        {/* Source attribution is a trust feature: a rep seeing whether a number came from
            QuickBooks or from a person is what makes the eventual cutover observable rather
            than silent. */}
        <span className={styles.source}>{sourceLabel(row.source)}</span>
        {' · '}
        <RelativeTime iso={row.updated_at} />
      </p>

      <div id={panelId} className={styles.panel} hidden={!expanded}>
        <dl className={styles.details}>
          <div className={styles.detailRow}>
            <dt>Category</dt>
            <dd>{row.category}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Full name</dt>
            <dd>{row.name}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>On hand</dt>
            <dd>{row.qty_on_hand}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Committed (QuickBooks)</dt>
            <dd>{row.qty_committed_source}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Committed by reps</dt>
            <dd>{row.qty_committed_portal}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Available (QuickBooks)</dt>
            <dd>{row.qty_available_source}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Available (incl. rep commitments)</dt>
            <dd>{row.qty_available}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Incoming</dt>
            <dd>
              {row.qty_incoming}
              {row.incoming_eta ? ` · arriving ${formatAbsolute(row.incoming_eta)}` : ''}
            </dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Unit</dt>
            <dd>{row.uom}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Low-stock threshold</dt>
            <dd>{row.low_stock_threshold}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Source</dt>
            <dd>{sourceLabel(row.source)}</dd>
          </div>
        </dl>

        {row.source === 'manual_override' ? (
          <div className={styles.override}>
            <p className={styles.overrideHeading}>Manual override</p>
            {row.override_note ? <p className={styles.overrideNote}>{row.override_note}</p> : null}
            <p className={styles.overrideBy}>
              {/* The email is shown only when the viewer is allowed to resolve it. RLS on
                  `profiles` lets a rep read their own row only, so for a rep this falls back
                  to "internal staff" rather than leaking a colleague's address. */}
              overridden by {overrideAuthor ?? 'internal staff'}
              {row.override_at ? (
                <>
                  {' · '}
                  <RelativeTime iso={row.override_at} />
                </>
              ) : null}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  )
}
