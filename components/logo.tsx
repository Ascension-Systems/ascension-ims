/**
 * The app mark.
 *
 * Rebranded to Plantation Prestige 2026-08-24. This is a TYPOGRAPHIC PLACEHOLDER MARK — a
 * rounded square in the brand brown with a cream monogram, echoing the brown square favicon on
 * plantationprestige.com. It deliberately does NOT reproduce their actual logo artwork, which we
 * do not have a file for; drop their real asset into public/brand/ and swap this component's
 * body for an <img> when they supply it.
 *
 * Inline SVG rather than a bitmap so it inherits the brand tokens and stays crisp at any size
 * (and needs no round trip). `alt`/`role` handling matches the previous mark: empty when a text
 * wordmark sits beside it, since the wordmark carries the name.
 */
export function BrandMark({ className, alt = '' }: { className?: string; alt?: string }) {
  const labelled = alt.length > 0
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? alt : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <rect width="48" height="48" rx="11" fill="var(--accent)" />
      <text
        x="24"
        y="24"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-display)"
        fontSize="21"
        fontWeight="600"
        letterSpacing="-0.5"
        fill="var(--accent-tint)"
      >
        PP
      </text>
    </svg>
  )
}
