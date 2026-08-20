'use client'

import { useState } from 'react'
import styles from '@/app/message.module.css'

/**
 * Enrollment: access code, work email, and a password the rep chooses. On success they are
 * signed in and dropped on the inventory page -- no email, no link.
 *
 * The confirm-password field is deliberate: a typo here would lock a rep out of an account
 * they cannot reset without help, so it is caught before submission.
 *
 * Every server refusal renders the SAME message, because the server returns the same message
 * for every refusal -- a precise "not invited" would make this public page a roster oracle.
 */
const MIN_PASSWORD = 8

export function JoinForm() {
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const passwordOk = password.length >= MIN_PASSWORD
  const match = password === confirm
  const ready = code.trim().length >= 8 && emailOk && passwordOk && match

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!match) {
      setError('The two passwords do not match.')
      return
    }
    if (!passwordOk) {
      setError(`Choose a password of at least ${MIN_PASSWORD} characters.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), email: email.trim(), password }),
      })
      const body = await res.json().catch(() => null)

      if (res.ok && body?.next) {
        // Signed in server-side already; just go where the server sent us.
        window.location.assign(body.next)
        return
      }
      setError(body?.message ?? 'Something went wrong. Try again in a moment.')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="join-code">
          Access code
        </label>
        <input
          id="join-code"
          className={styles.input}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="join-email">
          Work email
        </label>
        <input
          id="join-email"
          className={styles.input}
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="join-password">
          Choose a password
        </label>
        <input
          id="join-password"
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
        <span className={styles.help}>At least {MIN_PASSWORD} characters.</span>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="join-confirm">
          Confirm password
        </label>
        <input
          id="join-confirm"
          className={styles.input}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
      </div>

      <button type="submit" className={styles.submit} disabled={busy || !ready}>
        {busy ? 'Setting up…' : 'Set up and sign in'}
      </button>

      {error ? (
        <p className={styles.noticeError} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
