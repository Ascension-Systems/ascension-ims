import Link from 'next/link'
import styles from './message.module.css'

export default function NotFound() {
  return (
    <main className={styles.main}>
      <h1 className={styles.heading}>Page not found</h1>
      <p className={styles.body}>That address does not match anything in this app.</p>
      <Link className={styles.action} href="/inventory">
        Go to inventory
      </Link>
    </main>
  )
}
