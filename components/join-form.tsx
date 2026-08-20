'use client'

import { useState } from 'react'
import styles from '@/app/message.module.css'

/**
 * Enrollment form. Deliberately two fields and one button.
 *
 * Every refusal renders the SAME message, because the server returns the same message for
 * every refusal: a precise "that address is not invited" would turn this public page into a
 * roster oracle for the client's entire sales network.
 */
export function JoinForm() {
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = code.trim().length >= 8 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), email: email.trim() }),
      })
      const body = await res.json().catch(() => null)

      if (res.ok && body?.next) {
        // The existing auth callback establishes the session, exactly as a magic link does.
        window.location.assign(body.next)
        return
      }
      if (res.ok && body?.error === 'ENROLLED_NOT_SIGNED_IN') {
        setError(body.message)
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

      <button type="submit" className={styles.submit} disabled={busy || !ready}>
        {busy ? 'Setting up…' : 'Set up access'}
      </button>

      {error ? (
        <p className={styles.noticeError} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
