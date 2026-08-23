import styles from './loading.module.css'

/**
 * Shown in the content area (below the persistent nav from layout.tsx) while the next signed-in
 * page loads. A stable skeleton — title, subtitle, a few cards — so switching tabs transitions to
 * a designed placeholder instead of leaving the old screen frozen or flashing blank.
 */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true" aria-label="Loading">
      <div className={styles.intro}>
        <div className={`skeleton ${styles.title}`} />
        <div className={`skeleton ${styles.sub}`} />
      </div>
      <div className={styles.body}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`skeleton ${styles.card}`} />
        ))}
      </div>
    </main>
  )
}
