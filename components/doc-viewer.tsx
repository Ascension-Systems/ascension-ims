'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './doc-viewer.module.css'

/**
 * In-app document viewer. "View" opens the file (a PDF or image) in a modal INSIDE the app,
 * rather than the old `<a target="_blank">` that redirected the whole webview to the raw file —
 * which, in the Capacitor iOS shell, threw the rep out of the app into a file handler.
 *
 * Deliberately CSS-only (no framer-motion): a JS-driven exit animation that stalls in the iOS
 * WKWebView can leave a full-screen backdrop mounted over the app and block every tap. Enter
 * animation is CSS (doc-viewer.module.css); on close the modal unmounts immediately, so nothing
 * can ever be left covering the page. Re-introduce richer exit motion only once verified on-device.
 *
 * The iframe points at /api/documents/[id]/file, which streams the file inline (auth + RLS
 * enforced there); an "Open ↗" fallback covers any inline-render edge case.
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
              <a className={styles.external} href={fileUrl} target="_blank" rel="noopener noreferrer">
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={styles.frame}
                src={fileUrl}
                alt={title}
                onLoad={() => setLoading(false)}
                onError={() => setLoading(false)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
