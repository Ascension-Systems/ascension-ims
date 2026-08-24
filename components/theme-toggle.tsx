'use client'

import { useEffect, useState } from 'react'
import styles from './icon-button.module.css'

/**
 * Circular light/dark toggle, sized to match the sign-out button beside it. The actual theme is
 * already set on <html data-theme> before paint by the no-flash script in app/layout.tsx; this
 * only reads that attribute on mount (so the icon matches) and flips it on click, persisting the
 * choice. No theme state lives in React — <html data-theme> is the single source of truth.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    setTheme(current)
    setReady(true)
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* private mode — the choice just won't persist across reloads */
    }
    setTheme(next)
  }

  return (
    <button
      type="button"
      className={styles.button}
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      // Until mounted the icon could be wrong (SSR can't know the client theme); hide it for the
      // one paint before useEffect runs rather than flash the wrong glyph.
      style={ready ? undefined : { visibility: 'hidden' }}
    >
      {theme === 'dark' ? (
        // Sun — tapping returns to light.
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9" />
        </svg>
      ) : (
        // Moon — tapping goes to dark.
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M20.5 14.2A8.2 8.2 0 1 1 10.3 3.6a6.6 6.6 0 0 0 10.2 10.6Z" />
        </svg>
      )}
    </button>
  )
}
