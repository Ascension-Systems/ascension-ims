import styles from './loading.module.css'

/**
 * Static skeleton rows. NO ANIMATION -- no shimmer, no pulse. The brief forbids decorative
 * animation and a skeleton that moves is decoration.
 */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true" aria-label="Loading inventory">
      <div className={styles.bar} />
      <div className={styles.chips} />
      <ul className={styles.list}>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className={styles.card}>
            <span className={styles.name} />
            <span className={styles.sku} />
            <span className={styles.figure} />
          </li>
        ))}
      </ul>
    </main>
  )
}
