import Link from 'next/link'
import styles from '../../message.module.css'

/** No error codes shown to the user. */
export default function AuthCodeErrorPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.heading}>That link did not work</h1>
      <p className={styles.body}>
        Sign-in links expire after an hour and can only be used once. Request a new one and it
        will arrive in a moment.
      </p>
      <Link className={styles.action} href="/login">
        Request a new link
      </Link>
    </main>
  )
}
