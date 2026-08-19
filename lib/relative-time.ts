/** Pure, unit-testable relative-age formatting. No side effects, no ambient clock. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** The absolute short form, used for the server's first paint and for `title`. */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
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
