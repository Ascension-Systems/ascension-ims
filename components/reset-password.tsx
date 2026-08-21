'use client'

import { useState } from 'react'
import styles from './reset-password.module.css'

/**
 * Admin control on the roster: reset one person's password when they are locked out.
 *
 * There is no reset email in this deployment, so the flow is out of band. The admin clicks this,
 * the server mints a strong temporary password, and it is shown HERE exactly once for the admin
 * to relay. It is never persisted client-side and disappears on the next render/navigation.
 *
 * Only rendered for people who have finished setting up (claimed_at set): you cannot reset an
 * account that does not exist yet. The API is the real gate; this is the affordance.
 */
export function ResetPassword({ email }: { email: string }) {
  const [busy, setBusy] = useState(false)
  const [temp, setTemp] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function reset() {
    if (busy) return
    if (
      !window.confirm(
        `Reset the password for ${email}? Their current password stops working immediately and you will need to give them the new one.`,
      )
    )
      return
    setBusy(true)
    setError(null)
    setTemp(null)
    setCopied(false)
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.tempPassword) {
        setTemp(body.tempPassword)
      } else {
        setError(body?.message ?? 'Could not reset the password.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!temp) return
    try {
      await navigator.clipboard.writeText(temp)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — the password is displayed, so it can still be read out */
    }
  }

  return (
    <div className={styles.wrap}>
      {!temp ? (
        <button type="button" className={styles.trigger} onClick={reset} disabled={busy}>
          {busy ? 'Resetting…' : 'Reset password'}
        </button>
      ) : null}

      {temp ? (
        <div className={styles.panel} role="status" aria-live="polite">
          <p className={styles.panelLabel}>Temporary password</p>
          <div className={styles.codeRow}>
            <code className={styles.code}>{temp}</code>
            <button type="button" className={styles.copy} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className={styles.hint}>
            Give this to <strong>{email}</strong>. They sign in with it and can keep using it.
            You will not be able to see it again after leaving this page.
          </p>
          <button type="button" className={styles.dismiss} onClick={() => setTemp(null)}>
            Done
          </button>
        </div>
      ) : null}

      {error ? (
        <p className={styles.err} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
