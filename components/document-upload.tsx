'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './document-upload.module.css'

/**
 * Admin upload form, collapsed by default so it never crowds the reps' view of the same page.
 * Posts multipart to /api/documents, which does the real validation (type, magic bytes, size)
 * and admin check. This form only smooths the path; it is not the gate.
 */
const KINDS = [
  { value: 'promotion', label: 'Promotion' },
  { value: 'spec_sheet', label: 'Spec sheet' },
  { value: 'flyer', label: 'Flyer' },
  { value: 'price_sheet', label: 'Price sheet' },
]

export function DocumentUpload() {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('promotion')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data = new FormData(e.currentTarget)
      const res = await fetch('/api/documents', { method: 'POST', body: data })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(body?.message ?? 'Upload failed. Try again.')
        return
      }
      formRef.current?.reset()
      setKind('promotion')
      setOpen(false)
      router.refresh()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className={styles.bar}>
        <button type="button" className={styles.openBtn} onClick={() => setOpen(true)}>
          + Add a document
        </button>
      </div>
    )
  }

  return (
    <form ref={formRef} className={styles.form} onSubmit={submit}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="doc-kind">Type</label>
        <select
          id="doc-kind"
          name="kind"
          className={styles.input}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={busy}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="doc-title">Title</label>
        <input id="doc-title" name="title" className={styles.input} maxLength={200} required disabled={busy} />
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="doc-desc">Description <span className={styles.opt}>(optional)</span></label>
        <input id="doc-desc" name="description" className={styles.input} maxLength={1000} disabled={busy} />
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="doc-sku">Product SKU <span className={styles.opt}>(optional)</span></label>
        <input id="doc-sku" name="product_sku" className={styles.input} disabled={busy} autoCapitalize="characters" spellCheck={false} />
      </div>

      {kind === 'promotion' ? (
        <div className={styles.dates}>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="doc-start">Starts <span className={styles.opt}>(optional)</span></label>
            <input id="doc-start" name="starts_at" type="date" className={styles.input} disabled={busy} />
          </div>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="doc-end">Ends <span className={styles.opt}>(optional)</span></label>
            <input id="doc-end" name="ends_at" type="date" className={styles.input} disabled={busy} />
          </div>
        </div>
      ) : null}

      <div className={styles.row}>
        <label className={styles.label} htmlFor="doc-file">File <span className={styles.opt}>(PDF, PNG, JPG, WebP · max 25 MB)</span></label>
        <input
          id="doc-file"
          name="file"
          type="file"
          className={styles.file}
          accept="application/pdf,image/png,image/jpeg,image/webp"
          required
          disabled={busy}
        />
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <div className={styles.buttons}>
        <button type="button" className={styles.cancel} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  )
}
