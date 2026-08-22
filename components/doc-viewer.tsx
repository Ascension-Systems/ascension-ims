'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import styles from './doc-viewer.module.css'

/**
 * In-app document viewer. "View" opens the file (a PDF or image) in a modal INSIDE the app,
 * rather than the old `<a target="_blank">` that redirected the whole webview to the raw file —
 * which, in the Capacitor iOS shell, threw the rep out of the app into a file handler.
 *
 * Motion follows DESIGN.md: framer-motion AnimatePresence so the modal animates IN *and* OUT
 * (CSS alone can't animate an element React unmounts), on the one --ease-expo curve, with a
 * multi-property entrance. Disabled under prefers-reduced-motion.
 *
 * The iframe points at /api/documents/[id]/file, which streams the file inline (auth + RLS
 * enforced there); an "Open ↗" fallback covers any inline-render edge case.
 */
const EASE = [0.16, 1, 0.3, 1] as const

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
  const reduce = useReducedMotion()
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

  const backdrop = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.28, ease: EASE } }

  const panel = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 28, scale: 0.97, filter: 'blur(6px)' },
        animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
        exit: { opacity: 0, y: 16, scale: 0.985, filter: 'blur(4px)' },
        transition: { duration: 0.46, ease: EASE },
      }

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {label}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className={styles.backdrop}
            onClick={() => setOpen(false)}
            {...backdrop}
          >
            <motion.div
              className={styles.panel}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onClick={(e) => e.stopPropagation()}
              {...panel}
            >
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
                <iframe
                  className={styles.frame}
                  src={fileUrl}
                  title={title}
                  onLoad={() => setLoading(false)}
                />
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  )
}
