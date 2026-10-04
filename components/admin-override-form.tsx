'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './stock-form.module.css'
import own from './admin-override-form.module.css'

/**
 * Build-order step 3: an admin corrects an inventory figure.
 *
 * With QuickBooks stubbed, this is the ONLY path by which a real quantity enters the system —
 * and per the brief's open question 1, it stays the permanent correction layer even after the
 * integration lands, because hand-corrections to a wrong source figure ARE the real data.
 *
 * A REASON IS REQUIRED, not optional. The database constraint
 * `inventory_override_is_attributed` already forces override_note and override_at to be
 * non-null whenever source becomes 'manual_override', so an anonymous correction is
 * impossible at the schema level. Requiring it here surfaces that rule at the point of entry
 * rather than as a 500 later. An unexplained hand-edit to a number reps quote customers from
 * is precisely the silent override the show-both-numbers design exists to prevent.
 *
 * Committed is deliberately NOT editable here: it is QuickBooks' figure (open sales orders),
 * the only source of committed since 0025, and the database refuses the column (0013, 0025).
 */
export function AdminOverrideForm({
  sku,
  location,
  qtyOnHand,
  qtyIncoming,
}: {
  sku: string
  location: string
  qtyOnHand: number
  qtyIncoming: number
}) {
  const router = useRouter()
  const [onHand, setOnHand] = useState(String(qtyOnHand))
  const [incoming, setIncoming] = useState(String(qtyIncoming))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const onHandNum = Number(onHand)
  const incomingNum = Number(incoming)
  const valid =
    Number.isInteger(onHandNum) &&
    onHandNum >= 0 &&
    Number.isInteger(incomingNum) &&
    incomingNum >= 0 &&
    note.trim().length > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    setDone(null)

    try {
      const res = await fetch('/api/inventory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku,
          location,
          qty_on_hand: onHandNum,
          qty_incoming: incomingNum,
          note: note.trim(),
        }),
      })

      if (res.ok) {
        setDone('Correction saved. It is now shown as a manual override.')
        setNote('')
        router.refresh()
        return
      }

      const body = await res.json().catch(() => null)
      if (res.status === 403) setError('This action requires an admin account.')
      else if (res.status === 401) setError('Your session expired. Sign in again.')
      else if (res.status === 429) setError('Too many requests. Wait a moment and try again.')
      else setError(body?.message ?? 'Could not save that correction. Try again.')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={`${styles.form} ${own.form}`} onSubmit={submit}>
      <p className={`${styles.heading} ${own.heading}`}>Correct these numbers</p>

      <div className={own.grid}>
        <div className={styles.qtyField}>
          <label className={styles.label} htmlFor={`onhand-${sku}-${location}`}>
            On hand
          </label>
          <input
            id={`onhand-${sku}-${location}`}
            className={styles.qty}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={onHand}
            onChange={(e) => setOnHand(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className={styles.qtyField}>
          <label className={styles.label} htmlFor={`incoming-${sku}-${location}`}>
            Incoming
          </label>
          <input
            id={`incoming-${sku}-${location}`}
            className={styles.qty}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={incoming}
            onChange={(e) => setIncoming(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className={styles.noteField}>
        <label className={styles.label} htmlFor={`reason-${sku}-${location}`}>
          Reason <span className={own.required}>required</span>
        </label>
        <input
          id={`reason-${sku}-${location}`}
          className={styles.note}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. physical count after delivery"
          maxLength={280}
          disabled={busy}
        />
      </div>

      <p className={styles.hint}>
        Saving marks this row as a manual override, recorded against your name and the time.
        Reps see that the number was corrected by a person, not taken from QuickBooks.
      </p>

      <button type="submit" className={`${styles.submit} ${own.submit}`} disabled={busy || !valid}>
        {busy ? 'Saving…' : 'Save correction'}
      </button>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className={styles.done} role="status">
          {done}
        </p>
      ) : null}
    </form>
  )
}
