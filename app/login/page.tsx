import { requestMagicLink } from './actions'
import { LOGIN_ERROR } from './auth-error'
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
  searchParams: Promise<{ invalid?: string; error?: string }>
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

      {/*
        The send failed for a reason that is NOT about this address. Deliberately placed above
        the form, which stays usable, so the reader can retry immediately.

        Achromatic by construction: the state is carried by an icon, a label, a heavier border
        and its position — four non-colour channels, none of them optional. No colour token
        appears in .noticeError.

        An unrecognised ?error= value falls through to the `unavailable` wording rather than
        rendering nothing. Fail-safe: a value we do not recognise is never silently swallowed.

        The copy names no address, no error code, no status and no vendor, and it says the
        problem is not with the address — which is what keeps this branch from telling an
        attacker whether the address is registered.
      */}
      {params.error ? (
        <div className={styles.noticeError} role="alert">
          <span className={styles.noticeIcon} aria-hidden="true">
            !
          </span>
          <span>
            <strong className={styles.noticeLabel}>
              {params.error === LOGIN_ERROR.RATE_LIMITED ? 'Too many requests' : 'Cannot send'}
            </strong>
            <span className={styles.noticeText}>
              {params.error === LOGIN_ERROR.RATE_LIMITED
                ? 'Too many sign-in requests. Wait a minute, then try again.'
                : 'We could not send your sign-in link. This is a problem on our side, not with your address. Try again in a few minutes, or contact your Ascension representative if it keeps happening.'}
            </span>
          </span>
        </div>
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
