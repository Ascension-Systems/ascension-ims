'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './doc-actions.module.css'

/**
 * Admin-only per-document controls: hide/show (toggle active) and delete. Both hit the API,
 * which re-checks admin server-side, then refresh the server component so the list reflects
 * reality rather than optimistic guesses.
 */
export function DocActions({ id, active }: { id: string; active: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/documents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      })
      if (!res.ok) throw new Error()
      router.refresh()
    } catch {
      setError('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm('Remove this document for everyone? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      router.refresh()
    } catch {
      setError('Could not remove.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.action} onClick={toggle} disabled={busy}>
        {active ? 'Hide' : 'Show'}
      </button>
      <button type="button" className={styles.remove} onClick={remove} disabled={busy}>
        Remove
      </button>
      {error ? <span className={styles.err} role="alert">{error}</span> : null}
    </span>
  )
}
