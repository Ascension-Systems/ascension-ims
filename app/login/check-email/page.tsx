import Link from 'next/link'
import styles from '../../message.module.css'

/**
 * The response is IDENTICAL whether or not the address exists.
 *
 * Revealing which addresses are registered is a user-enumeration leak, and with ~120 named
 * external reps it is a real one. Do not add a "we couldn't find that account" branch here.
 */
export default function CheckEmailPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.heading}>Check your email</h1>
      <p className={styles.body}>
        If that address is registered, a sign-in link is on its way. The link works once and
        expires in an hour.
      </p>
      <Link className={styles.action} href="/login">
        Back to sign in
      </Link>
    </main>
  )
}
