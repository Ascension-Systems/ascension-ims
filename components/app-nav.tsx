'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton } from './sign-out-button'
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
  useEffect(() => {
    setPendingHref(null)
  }, [pathname])

  return (
    <header className={styles.bar}>
      <div className={styles.top}>
        <div className={styles.brand}>
          <BrandMark className={styles.mark} />
          <span className={styles.wordmark}>Ascension IT IMS</span>
        </div>
        <SignOutButton />
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
                onClick={() => setPendingHref(p.href)}
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
  )
}
