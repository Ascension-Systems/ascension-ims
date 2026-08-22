'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './doc-viewer.module.css'

/**
 * In-app document viewer. "View" opens the file (a PDF or image) in a modal INSIDE the app,
 * rather than the old `<a target="_blank">` that redirected the whole webview to the raw file —
 * which, in the Capacitor iOS shell, threw the rep out of the app into a file handler.
 *
 * The iframe points at /api/documents/[id]/file, which mints a short-lived signed URL and
 * redirects to it (auth + RLS enforced there); the iframe follows the redirect and renders the
 * file inline. An "Open ↗" fallback covers the rare case where inline rendering fails.
 */
export function DocViewer({
  id,
  title,
  triggerClassName,
  label = 'View',
}: {
  id: string
  title: string
  triggerClassName?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const closeRef = useRef<HTMLButtonElement>(null)
  const fileUrl = `/api/documents/${id}/file`

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div
          className={styles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={() => setOpen(false)}
        >
          <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.head}>
              <span className={styles.title}>{title}</span>
              <a
                className={styles.external}
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open ↗
              </a>
              <button
                ref={closeRef}
                type="button"
                className={styles.close}
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className={styles.frameWrap}>
              {loading ? (
                <div className={styles.loading}>
                  <span className="spinner" aria-hidden="true" /> Loading…
                </div>
              ) : null}
              <iframe
                className={styles.frame}
                src={fileUrl}
                title={title}
                onLoad={() => setLoading(false)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
