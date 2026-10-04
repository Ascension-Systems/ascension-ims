'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './sync-button.module.css'

/**
 * Runs a source sync on demand (POST /api/sync, admin-only, guarded twice).
 *
 * Applies the inventory source's rows (on hand, committed = open sales orders, incoming).
 * Manual overrides keep their corrected on-hand; their committed still follows the source.
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
        const applied = body?.run?.rows_applied ?? null
        const overrides = body?.run?.overrides_preserved ?? 0
        setMsg(
          `Sync complete.${applied !== null ? ` ${applied} row${applied === 1 ? '' : 's'} applied.` : ''}` +
            (overrides > 0 ? ` ${overrides} manual override${overrides === 1 ? '' : 's'} kept.` : ''),
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
