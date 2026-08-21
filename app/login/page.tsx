import Link from 'next/link'
import { signIn } from './actions'
import { BrandMark } from '@/components/logo'
import styles from '../message.module.css'

export const dynamic = 'force-dynamic'

/**
 * Email + password sign-in. A normal login form, because that is what people expect.
 * First-time reps set their password on /join with the access code.
 */
const ERRORS: Record<string, string> = {
  bad: 'That email and password did not match. Check both and try again.',
  missing: 'Enter your email and password.',
  rate: 'Too many attempts. Wait a minute, then try again.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const params = await searchParams
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.bad) : null

  return (
    <main className={styles.main}>
      <BrandMark className={styles.brandMark} alt="Ascension IT" />
      <h1 className={styles.heading}>Sign in</h1>
      <p className={styles.body}>Enter your work email and password.</p>

      {error ? (
        <div className={styles.noticeError} role="alert">
          <span className={styles.noticeIcon} aria-hidden="true">
            !
          </span>
          <span>
            <strong className={styles.noticeLabel}>Cannot sign in</strong>
            <span className={styles.noticeText}>{error}</span>
          </span>
        </div>
      ) : null}

      <form action={signIn} className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email
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
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className={styles.submit}>
          Sign in
        </button>
      </form>

      <p className={styles.subtle}>
        First time here? <Link href="/join">Set up your access</Link> with the code you were
        given.
      </p>
    </main>
  )
}
