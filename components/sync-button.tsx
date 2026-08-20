'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './sync-button.module.css'

/**
 * Runs a source sync on demand (POST /api/sync, admin-only, guarded twice).
 *
 * MANUAL BY DESIGN. There is no scheduled job anywhere in this build: an unattended job is
 * the most likely place a time-based retirement would later creep in, and time-based
 * retirement is the oversell bug. A person presses this, and the sync retires a commitment
 * only where the source demonstrably matches it.
 */
export function SyncButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        // Read the field /api/sync actually returns. The previous keys did not exist on the
        // response, so this always read 0 -- correct today only by coincidence, and a
        // landmine for whoever wires real matching.
        const confirmed = body?.run?.commitments_confirmed ?? 0
        const applied = body?.run?.rows_applied ?? null
        setMsg(
          confirmed > 0
            ? `Sync complete. ${confirmed} commitment${confirmed === 1 ? '' : 's'} confirmed by the source.`
            : `Sync complete.${applied !== null ? ` ${applied} row${applied === 1 ? '' : 's'} applied.` : ''} The source did not include any pending commitment, so none were retired.`,
        )
        router.refresh()
      } else {
        setMsg(body?.message ?? 'The sync could not be run.')
      }
    } catch {
      setMsg('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.button} onClick={run} disabled={busy}>
        {busy ? 'Syncing…' : 'Run sync'}
      </button>
      {msg ? (
        <p className={styles.msg} role="status">
          {msg}
        </p>
      ) : null}
    </div>
  )
}
