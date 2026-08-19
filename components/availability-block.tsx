import { availabilityPresentation, type StatusEncoding } from '@/lib/status'
import type { InventoryAuthority, InventoryViewRow } from '@/lib/types'
import styles from './availability-block.module.css'

/**
 * The show-both-numbers presentation.
 *
 * ONE CODE PATH, TWO MODES. Both authority modes read the same view, compute the same
 * figures and render this same component. The setting changes which figure is typographically
 * primary and how the secondary line is worded -- it is a setting, not a fork. The mode is
 * consulted in exactly one place, lib/status.ts's availabilityPresentation(), which returns
 * DATA; this component has no `if (mode === ...)` in it at all and there is no second
 * rendering branch to keep in sync.
 *
 * NEITHER MODE HIDES A NUMBER. NEITHER MODE SILENTLY OVERRIDES. In both, both figures are on
 * screen; only the emphasis moves.
 *
 * The figure is NOT clamped at zero. A negative availability means the source dropped on-hand
 * below what is already spoken for, which is exactly the condition a rep needs to see.
 */
export function AvailabilityBlock({
  row,
  authority,
  encoding,
}: {
  row: InventoryViewRow
  authority: InventoryAuthority
  encoding: StatusEncoding
}) {
  const presentation = availabilityPresentation(row, authority)

  return (
    <div className={styles.block}>
      <span className={styles.label}>{presentation.primaryLabel}</span>
      <span className={`${styles.figure} figure${encoding.variant}`}>
        {presentation.primaryValue}
      </span>
      {row.uom && row.uom !== 'EA' ? <span className={styles.uom}>{row.uom}</span> : null}
    </div>
  )
}

/**
 * The lines that accompany the figure. Separated from the figure itself because on a phone
 * they run the full width of the card underneath both columns, rather than being squeezed
 * into the right-hand column.
 */
export function AvailabilityLines({
  row,
  authority,
}: {
  row: InventoryViewRow
  authority: InventoryAuthority
}) {
  const presentation = availabilityPresentation(row, authority)

  return (
    <div className={styles.lines}>
      <p className={styles.components}>{presentation.componentsLine}</p>
      {presentation.advisoryLine ? (
        <p className={styles.advisory}>
          <span aria-hidden="true" className={styles.flag}>
            ⚑
          </span>{' '}
          {presentation.advisoryLine}
        </p>
      ) : null}
      {presentation.secondaryLine ? (
        <p className={styles.secondary}>{presentation.secondaryLine}</p>
      ) : null}
    </div>
  )
}
