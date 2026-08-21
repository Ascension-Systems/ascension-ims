'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton } from './sign-out-button'
import styles from './app-nav.module.css'

type Role = 'rep' | 'admin'

/**
 * The one navigation bar, shown identically on every signed-in screen. Before this, each page
 * carried its own ad-hoc header and a different scatter of links, so moving between screens meant
 * re-learning where the buttons were on each one. Now there is a single top bar: the app name,
 * the pages you can reach as tabs, and sign out — always in the same place.
 *
 * The active tab is filled, not just tinted: which screen you are on is carried by weight and
 * shape, not colour alone, so it survives a colourblind viewer and a greyscale screenshot.
 *
 * Each role sees only the screens it uses: a rep gets Inventory and their own commitments; an
 * admin gets Inventory, the reconciliation queue, and team access. The set is filtered here for
 * legibility only; the database is the real gate — a rep who types /reconciliation is bounced by
 * the page and would read nothing even if they weren't.
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

  return (
    <header className={styles.bar}>
      <div className={styles.top}>
        <span className={styles.wordmark}>Inventory</span>
        <SignOutButton />
      </div>

      {pages.length > 1 ? (
        <nav className={styles.tabs} aria-label="Pages">
          {pages.map((p) => {
            const active = pathname === p.href || pathname.startsWith(`${p.href}/`)
            return (
              <Link
                key={p.href}
                href={p.href}
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
