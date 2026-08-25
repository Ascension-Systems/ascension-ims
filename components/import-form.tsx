'use client'

import { useState } from 'react'
import styles from './invite-form.module.css'

/**
 * Admin: load the catalogue from a spreadsheet export.
 *
 * Answers "how do they get all the data in?" directly — they export CSV from Excel or
 * QuickBooks and drop it here. Reuses the invite form's stylesheet so there is no new CSS to
 * drift out of step with the rest of the admin console.
 *
 * PREVIEW FIRST, ALWAYS. The file is checked and reported on before anything is written, and
 * the apply button only appears once a preview has succeeded — an operator should never
 * discover what an import does by running it against their live price list.
 */
type Result = {
  committed: boolean
  columnsDetected: string[]
  rows: number
  truncated: boolean
  created: number
  updated: number
  skipped: number
  sample: { sku: string; action: string; detail?: string }[]
}

export function ImportForm() {
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(commit: boolean) {
    if (busy || !csv.trim()) return
    if (commit && !window.confirm('Apply this import to the live catalogue?')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/inventory/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, commit }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        setResult(body as Result)
      } else {
        setResult(null)
        setError(body?.message ?? 'Could not read that file.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null)
    setError(null)
    setCsv(await file.text())
  }

  return (
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); send(false) }}>
      <label className={styles.label} htmlFor="import-csv">
        Import catalogue from a spreadsheet
      </label>

      <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} style={{ marginBottom: 12 }} />

      <textarea
        id="import-csv"
        className={styles.textarea}
        value={csv}
        onChange={(e) => { setCsv(e.target.value); setResult(null) }}
        placeholder={
          'Choose a .csv above, or paste it here.\n\n' +
          'SKU,Name,Category,On Hand,Committed,Incoming\n' +
          'UMB-1001,11 ft Octagon Geneva Umbrella,Umbrellas,24,4,12'
        }
        rows={6}
        disabled={busy}
      />

      <button type="submit" className={styles.submit} disabled={busy || !csv.trim()}>
        {busy ? 'Checking…' : 'Preview import'}
      </button>

      {result ? (
        <>
          <p className={styles.ok} role="status">
            {result.committed ? 'Imported. ' : 'Preview only — nothing written yet. '}
            {result.rows} row{result.rows === 1 ? '' : 's'} read · {result.created}{' '}
            {result.committed ? 'created' : 'to create'} · {result.updated}{' '}
            {result.committed ? 'updated' : 'to update'} · {result.skipped} skipped
            {result.truncated ? ' · file truncated at 5,000 rows' : ''}
          </p>
          <p className={styles.hint}>Columns recognised: {result.columnsDetected.join(', ') || 'none'}</p>
          {result.sample.some((r) => r.detail) ? (
            <p className={styles.hint}>
              {result.sample.filter((r) => r.detail).slice(0, 5).map((r) => `${r.sku}: ${r.detail}`).join(' · ')}
            </p>
          ) : null}
          {!result.committed && result.created + result.updated > 0 ? (
            <button type="button" className={styles.submit} onClick={() => send(true)} disabled={busy}>
              Apply {result.created + result.updated} change
              {result.created + result.updated === 1 ? '' : 's'}
            </button>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p className={styles.err} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
