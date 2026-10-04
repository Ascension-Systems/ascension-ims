import { availabilityPresentation, type StatusEncoding } from '@/lib/status'
import type { InventoryViewRow } from '@/lib/types'
import styles from './availability-block.module.css'

/**
 * The availability figure: on hand minus QuickBooks' committed (open sales orders). The
 * wording comes from lib/status.ts's availabilityPresentation(), which returns DATA, so there
 * is one rendering path.
 *
 * The figure is NOT clamped at zero. A negative availability means QuickBooks has more on
 * open sales orders than on hand, which is exactly the condition a rep needs to see.
 */
export function AvailabilityBlock({
  row,
  encoding,
}: {
  row: InventoryViewRow
  encoding: StatusEncoding
}) {
  const presentation = availabilityPresentation(row)

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
export function AvailabilityLines({ row }: { row: InventoryViewRow }) {
  const presentation = availabilityPresentation(row)

  return (
    <div className={styles.lines}>
      <p className={styles.components}>{presentation.componentsLine}</p>
    </div>
  )
}
