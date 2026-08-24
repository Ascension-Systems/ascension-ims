import styles from './icon-button.module.css'

/**
 * Sign out — a compact circular icon button in the masthead, the same size as the theme toggle
 * beside it (both use icon-button.module.css).
 *
 * POST, not GET: a GET sign-out is CSRF-able and gets triggered by link prefetchers. The form
 * keeps the POST; only the presentation changed from a text button to an icon.
 */
export function SignOutButton() {
  return (
    <form action="/signout" method="post">
      <button type="submit" className={styles.button} aria-label="Sign out" title="Sign out">
        {/* Door with an out-arrow. */}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
          <path d="M10 12h9m0 0-3-3m3 3-3 3" />
        </svg>
      </button>
    </form>
  )
}
