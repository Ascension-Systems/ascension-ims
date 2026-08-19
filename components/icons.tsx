/**
 * Inline SVG status glyphs.
 *
 * Each silhouette is DELIBERATELY DISTINCT from every other, so the four stock statuses
 * remain tellable apart with colour and lightness removed entirely. Square, triangle,
 * down-arrow-in-a-dashed-ring and slashed-circle share no outline.
 *
 * Every glyph is aria-hidden: the badge's text label carries the accessible name. An icon
 * alone is never sufficient.
 *
 * currentColor throughout, so a glyph inverts correctly inside a solid-filled badge.
 */

type GlyphProps = { className?: string }

const base = {
  viewBox: '0 0 24 24',
  'aria-hidden': true as const,
  focusable: 'false' as const,
}

/** IN STOCK — a filled square. Solid, four-cornered, unmistakably "full". */
export function SquareGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <rect x="4" y="4" width="16" height="16" fill="currentColor" />
    </svg>
  )
}

/** LOW — an outlined triangle with a solid bottom third: a part-full gauge. */
export function TriangleGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3 L22 21 L2 21 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      {/* The solid bottom third — a second channel inside the glyph itself. */}
      <path d="M7.9 15 L16.1 15 L20.2 21 L3.8 21 Z" fill="currentColor" />
    </svg>
  )
}

/** NONE — INCOMING — a down-arrow inside a dashed ring. Dashed = "on its way". */
export function ArrowDownGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <circle
        cx="12"
        cy="12"
        r="9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="3 3"
      />
      <path
        d="M12 6 L12 16 M7.5 11.5 L12 16.5 L16.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** NONE AVAILABLE — a circle with a diagonal slash. The universal "not this". */
export function SlashedCircleGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5.3 18.7 L18.7 5.3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** STALE — a clock. Shares no silhouette with any stock glyph. */
export function ClockGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 6.5 L12 12 L16 14.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Chip selection mark. A third channel alongside inverted fill and inset border. */
export function CheckGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <path
        d="M4.5 12.5 L9.5 17.5 L19.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Clear (dismiss) mark for the search field. */
export function CloseGlyph({ className }: GlyphProps) {
  return (
    <svg {...base} className={className}>
      <path
        d="M6 6 L18 18 M18 6 L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Expand/collapse affordance on a product row. */
export function ChevronGlyph({ className, expanded }: GlyphProps & { expanded?: boolean }) {
  return (
    <svg {...base} className={className}>
      <path
        d={expanded ? 'M5 15 L12 8 L19 15' : 'M5 9 L12 16 L19 9'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function statusGlyph(
  glyph: 'square' | 'triangle' | 'arrow-down' | 'slashed-circle',
  className?: string,
) {
  switch (glyph) {
    case 'square':
      return <SquareGlyph className={className} />
    case 'triangle':
      return <TriangleGlyph className={className} />
    case 'arrow-down':
      return <ArrowDownGlyph className={className} />
    case 'slashed-circle':
      return <SlashedCircleGlyph className={className} />
  }
}
