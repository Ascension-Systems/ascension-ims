'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton } from './sign-out-button'
import { ThemeToggle } from './theme-toggle'
import { BrandMark } from './logo'
import styles from './app-nav.module.css'

type Role = 'rep' | 'admin'

/**
 * The one navigation bar, shown identically on every signed-in screen. Rendered once by the
 * signed-in layout (app/(app)/layout.tsx) so it stays fixed across navigations rather than
 * re-mounting per page.
 *
 * The active tab is filled, not just tinted: which screen you are on is carried by weight and
 * shape, not colour alone, so it survives a colourblind viewer and a greyscale screenshot.
 *
 * Each role sees only the screens it uses. The set is filtered here for legibility only; the
 * database is the real gate — a rep who types /reconciliation is bounced by the page.
 */
const PAGES: { href: string; label: string; roles: Role[] }[] = [
  { href: '/inventory', label: 'Inventory', roles: ['rep', 'admin'] },
  { href: '/resources', label: 'Resources', roles: ['rep', 'admin'] },
  { href: '/my-commitments', label: 'My commitments', roles: ['rep'] },
  { href: '/reconciliation', label: 'Reconciliation', roles: ['admin'] },
  { href: '/team', label: 'Team', roles: ['admin'] },
]

export function AppNav({ role }: { role: Role }) {
  const pathname = usePathname()
  const pages = PAGES.filter((p) => p.roles.includes(role))

  // Optimistic active tab: the instant a tab is tapped it takes the active (filled) style, before
  // the server-rendered page finishes loading — so a tap gives immediate colour feedback with NO
  // layout shift (no spinner widening the row). Cleared once the new path lands.
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  // Transition screen: a paper overlay with a spinner that covers the CONTENT (not the bar — it
  // sits below the nav's z-index, so the tapped tab stays lit on top). It exists to hide the lag
  // after the app has been backgrounded: iOS suspends the WKWebView, so the first navigation on
  // resume can stall for a beat, and without this the old page just sits there frozen and the tap
  // feels rejected. Shown a hair after the tap (not instantly) so a fast, warm navigation doesn't
  // flash it — only a genuinely slow one reveals the screen. Cleared the moment the route commits.
  const [transitioning, setTransitioning] = useState(false)

  useEffect(() => {
    // Route committed (or user landed here) — tear down all pending/transition state.
    setPendingHref(null)
    setTransitioning(false)
  }, [pathname])

  useEffect(() => {
    if (!pendingHref) return
    // Reveal the transition screen only if the navigation is actually taking a moment; a snappy
    // warm navigation resolves before this fires and never shows it.
    const reveal = setTimeout(() => setTransitioning(true), 140)
    // Safety net: never let the overlay get stuck if a navigation is cancelled or the path doesn't
    // change (e.g. an error, or tapping something that doesn't move).
    const safety = setTimeout(() => {
      setPendingHref(null)
      setTransitioning(false)
    }, 6000)
    return () => {
      clearTimeout(reveal)
      clearTimeout(safety)
    }
  }, [pendingHref])

  return (
    <>
      <header className={styles.bar}>
        <div className={styles.top}>
          <div className={styles.brand}>
            <BrandMark className={styles.mark} />
            <span className={styles.wordmark}>Plantation Prestige</span>
          </div>
          <div className={styles.actions}>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>

        {pages.length > 1 ? (
          <nav className={styles.tabs} aria-label="Pages">
            {pages.map((p) => {
              const active = pendingHref
                ? pendingHref === p.href
                : pathname === p.href || pathname.startsWith(`${p.href}/`)
              return (
                <Link
                  key={p.href}
                  href={p.href}
                  onClick={() => {
                    // Already here — let it no-op rather than arm a transition that can't clear
                    // (the path won't change, so the commit effect would never fire).
                    if (pathname === p.href) return
                    setPendingHref(p.href)
                  }}
                  className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                  aria-current={active ? 'page' : undefined}
                >
                  {p.label}
                </Link>
              )
            })}
          </nav>
        ) : null}
      </header>

      {transitioning ? (
        <div className={styles.transition} role="status" aria-live="polite" aria-label="Loading">
          <span className={styles.transitionSpinner} aria-hidden="true" />
        </div>
      ) : null}
    </>
  )
}
