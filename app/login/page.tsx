import { requestMagicLink } from './actions'
import styles from '../message.module.css'

export const dynamic = 'force-dynamic'

/**
 * A single email field and one submit button. Nothing else on the page.
 *
 * NO SIGN-UP LINK. NO "FORGOT PASSWORD". NO SOCIAL BUTTONS. NO PASSWORD FIELD. This system
 * uses magic links and stores no credentials; if a `password` input ever appears here,
 * something has gone wrong.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invalid?: string }>
}) {
  const params = await searchParams

  return (
    <main className={styles.main}>
      <h1 className={styles.heading}>Sign in</h1>
      <p className={styles.body}>
        Enter your email address and we will send you a sign-in link. No password needed.
      </p>

      {params.invalid ? (
        <p className={styles.notice}>Enter a valid email address.</p>
      ) : null}

      <form action={requestMagicLink} className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            className={styles.input}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <button type="submit" className={styles.submit}>
          Send sign-in link
        </button>
      </form>
    </main>
  )
}
