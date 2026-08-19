import type { StatusEncoding } from '@/lib/status'
import { statusGlyph } from '@/components/icons'

/**
 * Stock status, encoded on five channels at once: glyph silhouette, border style, fill
 * weight, label text and (via the row's left rule) position.
 *
 * THE LABEL IS ALWAYS RENDERED. Never icon-only, at any breakpoint. The glyph is aria-hidden
 * and the label carries the accessible name.
 */
export function StatusBadge({
  encoding,
  etaLabel,
}: {
  encoding: StatusEncoding
  /** e.g. "ETA 4 Sep". Rendered inside the badge for the incoming status only. */
  etaLabel?: string | null
}) {
  return (
    <span className={`statusBadge status${encoding.variant}`}>
      {statusGlyph(encoding.glyph)}
      <span>
        {encoding.label}
        {etaLabel ? ` · ${etaLabel}` : ''}
      </span>
    </span>
  )
}
