import styles from './sign-out-button.module.css'

/**
 * Posts to /signout. POST, not GET: a GET sign-out is CSRF-able and gets triggered by link
 * prefetchers.
 */
export function SignOutButton() {
  return (
    <form action="/signout" method="post" className={styles.form}>
      <button type="submit" className={styles.button}>
        Sign out
      </button>
    </form>
  )
}
