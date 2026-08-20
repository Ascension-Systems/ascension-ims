'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './commit-form.module.css'

/**
 * Build-order step 2: a rep records a commitment against a SKU.
 *
 * This is the product's whole thesis made operable — the portal learns about a sale at the
 * moment it happens, rather than when the paperwork reaches QuickBooks days later. Everything
 * hard about it already lives in the database: `record_commitment` (migration 0009) takes a
 * `FOR UPDATE` row lock, so two reps racing the last unit cannot both win, and the loser is
 * refused with SQLSTATE KY001. That refusal is verified against the hosted database by a
 * 20-way concurrent swarm (attack 2), so this form's job is to surface it honestly, not to
 * re-implement any of it.
 *
 * IDENTITY IS NEVER SENT. `record_commitment` reads `auth.uid()` internally and has no
 * rep_id parameter, so this form cannot commit on another rep's behalf even if it tried.
 *
 * THE LOSING CASE IS THE IMPORTANT ONE. A rep who is refused must understand immediately that
 * someone else took the stock and how much is actually left — not see a generic failure. The
 * 409 body carries the real remaining quantity, and it is shown as the primary message.
 */
export function CommitForm({
  sku,
  location,
  available,
  committedPortal,
  uom,
}: {
  sku: string
  location: string
  /** The conservative availability figure — the number this commitment is checked against. */
  available: number
  /** Rep commitments already recorded against this row. Used ONLY to decide whether the
      refusal may mention contention — never to assert it when there are none. */
  committedPortal: number
  uom: string
}) {
  const router = useRouter()
  const [qty, setQty] = useState('1')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const parsed = Number(qty)
  // Matches the route's bound. Postgres int4 overflows above 2147483647 and a raw overflow
  // was escaping as a 500 rather than a clean validation message.
  const qtyValid = Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !qtyValid) return
    setBusy(true)
    setError(null)
    setDone(null)

    try {
      const res = await fetch('/api/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku,
          qty: parsed,
          location,
          note: note.trim() || null,
        }),
      })

      if (res.ok) {
        setDone(`Committed ${parsed}${uom && uom !== 'EA' ? ` ${uom}` : ''}.`)
        setQty('1')
        setNote('')
        // Re-fetch the server component so every figure on the page reflects the new delta.
        // This is the live-availability moment: the number drops for this rep immediately,
        // and for every other session on their next load.
        router.refresh()
        return
      }

      // A 409 is not a failure to apologise for — it is the guard working. Lead with the
      // number that is actually left, and STATE ONLY WHAT IS TRUE: a shortfall does not
      // imply another rep took it. The stock can simply be short. Contention is mentioned
      // only when rep commitments genuinely exist on this row, so the message can never
      // contradict the "Committed by reps" figure on the same card.
      const body = await res.json().catch(() => null)
      if (res.status === 409) {
        const left = typeof body?.available === 'number' ? body.available : 0
        const contested = committedPortal > 0
        if (left > 0) {
          setError(
            contested
              ? `Only ${left} available — some of this stock is already committed by reps. Adjust the quantity and try again.`
              : `Only ${left} available. Adjust the quantity and try again.`,
          )
        } else {
          setError(
            contested
              ? 'None available — this stock is already fully committed.'
              : 'None available.',
          )
        }
      } else if (res.status === 401) {
        setError('Your session expired. Sign in again to record this.')
      } else if (res.status === 403) {
        setError('This account is not provisioned to record commitments.')
      } else if (res.status === 429) {
        setError('Too many requests. Wait a moment and try again.')
      } else {
        setError(body?.message ?? 'Could not record that commitment. Try again.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <p className={styles.heading}>Commit stock</p>

      <div className={styles.row}>
        <div className={styles.qtyField}>
          <label className={styles.label} htmlFor={`qty-${sku}-${location}`}>
            Quantity
          </label>
          <input
            id={`qty-${sku}-${location}`}
            className={styles.qty}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000000}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={busy}
          />
        </div>
        <button type="submit" className={styles.submit} disabled={busy || !qtyValid}>
          {busy ? 'Recording…' : 'Commit'}
        </button>
      </div>

      <div className={styles.noteField}>
        <label className={styles.label} htmlFor={`note-${sku}-${location}`}>
          Note <span className={styles.optional}>(optional)</span>
        </label>
        <input
          id={`note-${sku}-${location}`}
          className={styles.note}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Customer or order reference"
          maxLength={280}
          disabled={busy}
        />
      </div>

      <p className={styles.hint}>
        {available > 0
          ? `${available} available now. Recording a commitment reduces what every other rep sees, immediately.`
          : 'Nothing available. A commitment here will be refused.'}
      </p>

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
