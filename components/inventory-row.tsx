'use client'

import { AvailabilityBlock, AvailabilityLines } from '@/components/availability-block'
import { StatusBadge } from '@/components/status-badge'
import { StaleBadge } from '@/components/stale-badge'
import { RelativeTime } from '@/components/relative-time'
import { ChevronGlyph } from '@/components/icons'
import { CommitForm } from '@/components/commit-form'
import { AdminOverrideForm } from '@/components/admin-override-form'
import { rowStatus, sourceLabel } from '@/lib/status'
import { formatDateOnly, formatEta, formatRelativeAge } from '@/lib/relative-time'
import type { AppRole, InventoryAuthority, InventoryViewRow } from '@/lib/types'
import styles from './inventory-row.module.css'

/**
 * One product card.
 *
 * TAP TO EXPAND IN PLACE. There is no detail route: expansion is an in-place accordion, so
 * there is no navigation, no back button and no lost scroll position. That keeps the
 * three-tap budget (chip or search -> row -> read).
 */

export function InventoryRow({
  row,
  authority,
  stale,
  serverNow,
  expanded,
  onToggle,
  overrideAuthor,
  viewerRole,
}: {
  row: InventoryViewRow
  authority: InventoryAuthority
  stale: boolean
  serverNow: number
  expanded: boolean
  onToggle: () => void
  /** Resolved email of the override author, or null when the viewer may not read it. */
  overrideAuthor?: string | null
  /** Drives which step-2/step-3 controls appear. The DATABASE is the real gate -- these
      controls being hidden is a convenience, never the access control. */
  viewerRole: AppRole
}) {
  const encoding = rowStatus(row)
  const eta = row.qty_incoming > 0 ? formatEta(row.incoming_eta) : null
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
        {/* Product photo. Decorative here — the name beside it is the label — so alt is empty
            and a missing photo simply collapses rather than leaving a broken-image box. */}
        {row.image_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.thumb}
            src={`/api/products/${encodeURIComponent(row.sku)}/image`}
            alt=""
            /* NOT loading="lazy". The lazy trigger failed to fire for these thumbnails —
               including for rows already inside the viewport — so the catalogue rendered with
               no photographs at all, which was hit during a live client demo. A controlled test
               on the deployed build showed the identical URL loading immediately when requested
               eagerly and never loading when requested lazily. The images are small (catalogue
               shots are resized to ~7-20KB each), so eager loading costs far less than the
               failure mode it removes. components/sheet-list.tsx was changed the same way
               earlier for the same symptom. */
            decoding="async"
          />
        ) : null}

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

      {/* AvailabilityLines and the source/updated line used to render HERE, in the collapsed
          summary. Every figure they showed is already in the <dl> below, so the collapsed card
          was ~660px tall on a 375px phone -- one product per screen for a rep scanning 97 of
          them. They now render inside the panel; nothing was lost, only de-duplicated. */}
      {/* The panel WRAPPER always renders so aria-controls always resolves to a real element.
          Its CONTENTS render only when open. Previously the whole panel -- a full <dl>, a
          CommitForm, and for admins an AdminOverrideForm -- was emitted for all 97 rows and
          merely hidden with `hidden`, which hides pixels, not bytes: the inventory document was
          435 KB on the deployed site. Collapsed rows now cost their summary only. */}
      <div id={panelId} className={styles.panel} hidden={!expanded}>
        {expanded ? (
          <>
          <AvailabilityLines row={row} authority={authority} />

          <p className={styles.meta}>
            {/* Source attribution is a trust feature: a rep seeing whether a number came from
                QuickBooks or from a person is what makes the eventual cutover observable rather
                than silent. */}
            <span className={styles.source}>{sourceLabel(row.source)}</span>
            {' · '}
            <RelativeTime iso={row.updated_at} />
          </p>

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
                {row.incoming_eta ? ` · arriving ${formatDateOnly(row.incoming_eta)}` : ''}
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

          {/* "You hit something else and it links back to the Plantation Prestige website"
              (Levon, 2026-08-24). Rendered only when the product actually has a public page —
              he flagged that not everything they sell is online — so this is never a dead link.
              Opens in a new context rather than navigating the app away from the catalogue. */}
          {row.product_url ? (
            <a
              className={styles.productLink}
              href={row.product_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on plantationprestige.com ↗
            </a>
          ) : null}

          {/* Step 2 — recording a commitment. Available to every provisioned account: the
              database permits any authenticated identity with a profiles row (record_commitment
              takes no rep_id and reads auth.uid()), and an admin selling stock is a real case.
              Rendered only inside the expanded panel so the list stays scannable. */}
          <CommitForm
            sku={row.sku}
            location={row.location}
            available={row.qty_available}
            committedPortal={row.qty_committed_portal}
            uom={row.uom}
          />

          {/* Step 3 — admin correction. HIDING THIS IS NOT THE ACCESS CONTROL: RLS policy
              inventory_update_admin refuses a rep's UPDATE at the database, and attack 4 proves
              it by making the identical request as a rep and observing 0 rows plus an unchanged
              row. This check only keeps a control a rep cannot use off their screen. */}
          {viewerRole === 'admin' ? (
            <AdminOverrideForm
              sku={row.sku}
              location={row.location}
              qtyOnHand={row.qty_on_hand}
              qtyIncoming={row.qty_incoming}
            />
          ) : null}
          </>
        ) : null}
      </div>
    </li>
  )
}
