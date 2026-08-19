/** Pure, unit-testable relative-age formatting. No side effects, no ambient clock. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** The absolute short form of a TIMESTAMP, used for the server's first paint. */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/**
 * The absolute short form of a DATE-ONLY value, such as `incoming_eta`.
 *
 * Read in UTC deliberately. `new Date('2026-09-09')` parses as UTC midnight, so reading it
 * back with the local-time accessors shows the 8th anywhere west of Greenwich. An ETA that is
 * a day early is a delivery promise the client cannot keep.
 */
export function formatDateOnly(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Short ETA form for the status badge, e.g. "ETA 4 Sep". Same UTC reasoning. */
export function formatEta(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return null
  return `ETA ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/**
 * "updated 4 minutes ago" and friends.
 *
 *   < 60s   updated just now
 *   < 60min updated 4 minutes ago
 *   < 24h   updated 7 hours ago
 *   < 7d    updated 3 days ago
 *   else    updated on 3 Mar 2026
 */
export function formatRelativeAge(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'updated at an unknown time'

  const delta = now - then
  if (delta < 0) return 'updated just now'
  if (delta < MINUTE) return 'updated just now'
  if (delta < HOUR) return `updated ${plural(Math.floor(delta / MINUTE), 'minute')} ago`
  if (delta < DAY) return `updated ${plural(Math.floor(delta / HOUR), 'hour')} ago`
  if (delta < 7 * DAY) return `updated ${plural(Math.floor(delta / DAY), 'day')} ago`
  return `updated on ${formatAbsolute(iso)}`
}

/** Minutes elapsed since `iso`, used for the staleness threshold. */
export function ageInMinutes(iso: string, now: number): number {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - then) / MINUTE)
}
