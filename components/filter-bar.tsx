'use client'

import { CheckGlyph } from '@/components/icons'
import styles from './filter-bar.module.css'

/**
 * Category and status chips, plus sort.
 *
 * Selection is encoded on three channels -- inverted fill, a 2px inset border, and a check
 * glyph prefixing the label -- never on colour, and never on lightness alone. See the CSS.
 *
 * Each group is a horizontally scrollable row, 44px tall, so chips never wrap into a second
 * line and push the list below the fold on a phone.
 */

export type StatusFilter = 'all' | 'in-stock' | 'low' | 'none' | 'stale'
export type SortKey = 'name' | 'least-available' | 'recently-updated'

const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in-stock', label: 'In stock' },
  { key: 'low', label: 'Low' },
  { key: 'none', label: 'None available' },
  { key: 'stale', label: 'Stale' },
]

const SORT_CHIPS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name A→Z' },
  { key: 'least-available', label: 'Least available' },
  { key: 'recently-updated', label: 'Recently updated' },
]

function Chip({
  selected,
  label,
  onClick,
}: {
  selected: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {selected ? <CheckGlyph /> : null}
      <span>{label}</span>
    </button>
  )
}

export function FilterBar({
  categories,
  category,
  onCategory,
  status,
  onStatus,
  sort,
  onSort,
}: {
  categories: string[]
  category: string
  onCategory: (next: string) => void
  status: StatusFilter
  onStatus: (next: StatusFilter) => void
  sort: SortKey
  onSort: (next: SortKey) => void
}) {
  return (
    <div className={styles.bar}>
      <div className={styles.group} role="group" aria-label="Filter by category">
        <span className={styles.groupLabel}>Category</span>
        <Chip selected={category === 'all'} label="All" onClick={() => onCategory('all')} />
        {categories.map((c) => (
          <Chip key={c} selected={category === c} label={c} onClick={() => onCategory(c)} />
        ))}
      </div>

      <div className={styles.group} role="group" aria-label="Filter by stock status">
        <span className={styles.groupLabel}>Status</span>
        {STATUS_CHIPS.map((c) => (
          <Chip
            key={c.key}
            selected={status === c.key}
            label={c.label}
            onClick={() => onStatus(c.key)}
          />
        ))}
      </div>

      <div className={styles.group} role="group" aria-label="Sort order">
        <span className={styles.groupLabel}>Sort</span>
        {SORT_CHIPS.map((c) => (
          <Chip key={c.key} selected={sort === c.key} label={c.label} onClick={() => onSort(c.key)} />
        ))}
      </div>
    </div>
  )
}
