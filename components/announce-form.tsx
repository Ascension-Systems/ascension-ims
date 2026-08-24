'use client'

import { useState } from 'react'
import styles from './invite-form.module.css'

/**
 * Admin: push an announcement to every registered device. Deliberately reuses the invite
 * form's stylesheet — same card, same controls, zero new CSS to drift.
 *
 * The 180-character cap is enforced here for feedback and again in /api/announce for real;
 * a push notification body has one lock-screen line to make its point.
 */
const MAX = 180

export function AnnounceForm() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !message.trim()) return
    if (!window.confirm('Send this to every registered device right now?')) return
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch('/api/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        setResult('Sent. Your own device gets it too — that is the delivery proof.')
        setMessage('')
      } else {
        setError(body?.message ?? 'Could not send the announcement.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.label} htmlFor="announce-message">
        Send an announcement
      </label>
      <textarea
        id="announce-message"
        className={styles.textarea}
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, MAX))}
        placeholder="One clear sentence — it lands on every lock screen. e.g. New floor pricing starts Monday."
        rows={3}
        disabled={busy}
      />
      <button type="submit" className={styles.submit} disabled={busy || !message.trim()}>
        {busy ? 'Sending…' : `Notify everyone (${MAX - message.length} left)`}
      </button>
      {result ? (
        <p className={styles.ok} role="status">
          {result}
        </p>
      ) : null}
      {error ? (
        <p className={styles.err} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
