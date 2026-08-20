'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './invite-form.module.css'

/**
 * Admin: paste the rep list, then share the access code.
 *
 * Accepts whatever shape the list arrives in -- newlines, commas, a column pasted from a
 * spreadsheet -- because an operator should not have to reformat a client's roster by hand.
 * Re-pasting the same list is a normal action and never resets someone already set up.
 */
export function InviteForm({
  code,
  uses,
  maxUses,
}: {
  code: string | null
  uses: number
  maxUses: number | null
}) {
  const router = useRouter()
  const [emails, setEmails] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !emails.trim()) return
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        const bits = [`${body.added} added`]
        if (body.alreadyInvited > 0) bits.push(`${body.alreadyInvited} already on the list`)
        if (body.invalid?.length) bits.push(`${body.invalid.length} skipped as invalid`)
        setResult(bits.join(' · '))
        setEmails('')
        router.refresh()
      } else {
        setError(body?.message ?? 'Could not add those addresses.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — the code is displayed, so it can still be read out */
    }
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.codeCard}>
        <p className={styles.label}>Access code</p>
        {code ? (
          <>
            <div className={styles.codeRow}>
              <code className={styles.code}>{code}</code>
              <button type="button" className={styles.copy} onClick={copyCode}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className={styles.hint}>
              Share this with your reps however you like — it is useless on its own. It only
              works for an address on the list below.
              {maxUses !== null ? ` Used ${uses} of ${maxUses}.` : ` Used ${uses} times.`}
            </p>
          </>
        ) : (
          <p className={styles.hint}>
            No active code yet. One is created when the enrollment migration is applied.
          </p>
        )}
      </section>

      <form className={styles.form} onSubmit={submit}>
        <label className={styles.label} htmlFor="invite-emails">
          Add reps
        </label>
        <textarea
          id="invite-emails"
          className={styles.textarea}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={'Paste email addresses — one per line, or comma separated.\n\nrep.one@firm.com\nrep.two@firm.com'}
          rows={6}
          disabled={busy}
        />
        <button type="submit" className={styles.submit} disabled={busy || !emails.trim()}>
          {busy ? 'Adding…' : 'Add to the list'}
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
    </div>
  )
}
