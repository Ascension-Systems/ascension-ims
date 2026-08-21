'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './invite-form.module.css'

/**
 * Admin: manage onboarding codes and the allowlist.
 *
 * Two codes, two roles. The REP code can be rotated here (generate a fresh one; the old one
 * stops working for new sign-ups, but nobody already set up is affected). The ADMIN code is
 * shown read-only — it is minted by the operator, not from the UI — and only works for an
 * address invited AS an admin. Provisioning an admin therefore needs BOTH, which is what keeps
 * a leaked admin code from minting admins.
 */
export function InviteForm({
  repCode,
  repUses,
  repMaxUses,
  adminCode,
}: {
  repCode: string | null
  repUses: number
  repMaxUses: number | null
  adminCode: string | null
}) {
  const router = useRouter()
  const [emails, setEmails] = useState('')
  const [inviteRole, setInviteRole] = useState<'rep' | 'admin'>('rep')
  const [busy, setBusy] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(value: string, which: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      /* clipboard unavailable — the code is displayed, so it can still be read out */
    }
  }

  async function rotateCode() {
    if (rotating) return
    if (
      !window.confirm(
        'Generate a new rep code? The current one stops working for new sign-ups. Anyone already set up is unaffected.',
      )
    )
      return
    setRotating(true)
    setError(null)
    try {
      const res = await fetch('/api/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate: true }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) router.refresh()
      else setError(body?.message ?? 'Could not rotate the code.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setRotating(false)
    }
  }

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
        body: JSON.stringify({ emails, role: inviteRole }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        const bits = [`${body.added} added`]
        if (body.alreadyInvited > 0) bits.push(`${body.alreadyInvited} already on the list`)
        if (body.invalid?.length) bits.push(`${body.invalid.length} skipped as invalid`)
        setResult(`${inviteRole === 'admin' ? 'As admins · ' : ''}${bits.join(' · ')}`)
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

  return (
    <div className={styles.wrap}>
      <section className={styles.codeCard}>
        <p className={styles.label}>Rep access code</p>
        {repCode ? (
          <>
            <div className={styles.codeRow}>
              <code className={styles.code}>{repCode}</code>
              <button type="button" className={styles.copy} onClick={() => copy(repCode, 'rep')}>
                {copied === 'rep' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className={styles.hint}>
              Share this with your reps — it is useless on its own. It only works for an address
              on the list below.
              {repMaxUses !== null ? ` Used ${repUses} of ${repMaxUses}.` : ` Used ${repUses} times.`}
            </p>
          </>
        ) : (
          <p className={styles.hint}>No active rep code yet — generate one.</p>
        )}
        <button type="button" className={styles.rotate} onClick={rotateCode} disabled={rotating}>
          {rotating ? 'Generating…' : repCode ? 'Generate a new code' : 'Create a rep code'}
        </button>
      </section>

      {adminCode ? (
        <section className={styles.adminCard}>
          <p className={styles.label}>Admin onboarding code</p>
          <div className={styles.codeRow}>
            <code className={styles.code}>{adminCode}</code>
            <button type="button" className={styles.copy} onClick={() => copy(adminCode, 'admin')}>
              {copied === 'admin' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className={styles.hint}>
            Only works for someone invited <strong>as an admin</strong> below. Hand it out
            sparingly.
          </p>
        </section>
      ) : null}

      <form className={styles.form} onSubmit={submit}>
        <label className={styles.label} htmlFor="invite-emails">
          Add people
        </label>
        <div className={styles.roleToggle} role="radiogroup" aria-label="Invite as">
          <button
            type="button"
            className={inviteRole === 'rep' ? `${styles.roleBtn} ${styles.roleActive}` : styles.roleBtn}
            aria-pressed={inviteRole === 'rep'}
            onClick={() => setInviteRole('rep')}
          >
            Reps
          </button>
          <button
            type="button"
            className={inviteRole === 'admin' ? `${styles.roleBtn} ${styles.roleActive}` : styles.roleBtn}
            aria-pressed={inviteRole === 'admin'}
            onClick={() => setInviteRole('admin')}
          >
            Admins
          </button>
        </div>
        <textarea
          id="invite-emails"
          className={styles.textarea}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={'Paste email addresses — one per line, or comma separated.\n\nname.one@firm.com\nname.two@firm.com'}
          rows={6}
          disabled={busy}
        />
        <button type="submit" className={styles.submit} disabled={busy || !emails.trim()}>
          {busy ? 'Adding…' : inviteRole === 'admin' ? 'Add as admins' : 'Add to the list'}
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
