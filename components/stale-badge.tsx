import { ClockGlyph } from '@/components/icons'

/**
 * Freshness. ADDITIVE and ORTHOGONAL to stock status -- an item can be Low and Stale at
 * once, and this renders as a second badge so neither hides the other.
 *
 * It sits AFTER the stock badge in document order so screen readers announce stock status
 * first.
 */
export function StaleBadge({ ageLabel }: { ageLabel: string }) {
  return (
    <span className="staleBadge">
      <ClockGlyph />
      <span>STALE · {ageLabel}</span>
    </span>
  )
}
