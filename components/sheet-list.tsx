'use client'

import { useMemo, useState } from 'react'
import { DocActions } from './doc-actions'
import { DocViewer } from './doc-viewer'
import styles from './sheet-list.module.css'

type Sheet = {
  id: string
  title: string
  description: string | null
  productName: string | null
  active: boolean
  kind: string
}

const KIND_LABEL: Record<string, string> = {
  spec_sheet: 'Spec sheet',
  flyer: 'Flyer',
  price_sheet: 'Price sheet',
}

/**
 * The spec-sheet / flyer library with instant client-side search over titles and product names.
 * The list is already scoped by RLS on the server; filtering here is convenience, not a gate.
 */
export function SheetList({ items, isAdmin }: { items: Sheet[]; isAdmin: boolean }) {
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return items
    return items.filter(
      (s) =>
        s.title.toLowerCase().includes(term) ||
        (s.productName ?? '').toLowerCase().includes(term),
    )
  }, [q, items])

  if (items.length === 0) {
    return <p className={styles.empty}>No spec sheets yet.</p>
  }

  return (
    <div>
      <input
        className={styles.search}
        type="search"
        placeholder="Search spec sheets"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search spec sheets"
      />

      {filtered.length === 0 ? (
        <p className={styles.empty}>Nothing matches “{q}”.</p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((s) => {
            const hidden = isAdmin && !s.active
            return (
              <li key={s.id} className={`${styles.item} ${hidden ? styles.itemHidden : ''}`}>
                {/* A small crop of the sheet itself, so the library scans as documents rather
                    than as a list of filenames. Tapping it opens the same viewer as "View". */}
                <DocViewer id={s.id} title={s.title} triggerClassName={styles.thumbBtn}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className={styles.thumb}
                    src={`/api/documents/${s.id}/file`}
                    alt=""
                    decoding="async"
                  />
                </DocViewer>

                <div className={styles.body}>
                  <p className={styles.itemTitle}>{s.title}</p>
                  <p className={styles.itemMeta}>
                    {KIND_LABEL[s.kind] ?? 'Document'}
                    {s.productName && s.productName !== s.title ? ` · ${s.productName}` : ''}
                  </p>
                  {hidden ? <span className={styles.hiddenTag}>Hidden from reps</span> : null}
                </div>
                <div className={styles.actions}>
                  <DocViewer id={s.id} title={s.title} triggerClassName={styles.viewBtn} />
                  {isAdmin ? <DocActions id={s.id} active={s.active} /> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
