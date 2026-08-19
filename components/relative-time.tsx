'use client'

import { useEffect, useState } from 'react'
import { formatAbsolute, formatRelativeAge } from '@/lib/relative-time'

/**
 * Two-phase render, deliberately.
 *
 * The server renders the ABSOLUTE short date; the client swaps in the relative string on
 * mount and re-renders every 60 seconds. Rendering a relative time directly on the server
 * produces a hydration mismatch that Next reports as an error, because the server's clock
 * reading and the client's differ by the time in flight. This is a known trap and the reason
 * for the two phases.
 *
 * suppressHydrationWarning covers the intended first-paint difference.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    const tick = () => setLabel(formatRelativeAge(iso, Date.now()))
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [iso])

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {label ?? `updated on ${formatAbsolute(iso)}`}
    </time>
  )
}
