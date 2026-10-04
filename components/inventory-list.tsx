'use client'

import { useMemo, useState } from 'react'
import { SearchField } from '@/components/search-field'
import { FilterBar, type SortKey, type StatusFilter } from '@/components/filter-bar'
import { InventoryRow } from '@/components/inventory-row'
import { isStale, stockStatus } from '@/lib/status'
import type { AppRole, AppSettings, InventoryViewRow } from '@/lib/types'
import styles from './inventory-list.module.css'

/**
 * Search, filter and sort over the FULL row set, on the client.
 *
 * The catalogue is ~97 rows / ~30KB of JSON. A round trip per keystroke on a phone with poor
 * signal is worse than every alternative, and it makes search feel broken in exactly the
 * conditions this app is used in. Revisit above ~2,000 rows.
 *
 * Selections live in React state only. No URL params in step 1 -- there is nothing to
 * deep-link to yet.
 */

function matchesStatus(
  row: InventoryViewRow,
  filter: StatusFilter,
  stale: boolean,
): boolean {
  if (filter === 'all') return true
  if (filter === 'stale') return stale
  const status = stockStatus(row.qty_available, row.low_stock_threshold, row.qty_incoming)
  if (filter === 'none') return status === 'none' || status === 'none-incoming'
  return status === filter
}

/**
 * Name order for a catalogue where many products are named by a dimension first
 * ("10' Square Edison Cantilever", "6.5' Square Geneva Umbrella").
 *
 * A plain localeCompare sorts digits before letters, so every size-led name collected at the
 * very top — the catalogue opened on ten near-identical umbrellas before reaching a single
 * chair or table. Size-led names now sort AFTER word-led ones, and among themselves they sort
 * numerically (6.5' before 10', not "10" before "6.5" as string order would have it).
 */
function leadingSize(name: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*['\u2032"]?/.exec(name.trim())
  return m && m[1] !== undefined ? Number(m[1]) : null
}

function byProductName(a: string, b: string): number {
  const sa = leadingSize(a)
  const sb = leadingSize(b)
  if (sa === null && sb !== null) return -1
  if (sa !== null && sb === null) return 1
  if (sa !== null && sb !== null && sa !== sb) return sa - sb
  return a.localeCompare(b)
}

export function InventoryList({
  rows,
  categories,
  settings,
  serverNow,
  overrideAuthors,
  viewerRole,
}: {
  rows: InventoryViewRow[]
  categories: string[]
  settings: AppSettings
  /**
   * The server's clock, passed down so the FIRST PAINT computes staleness server-side and
   * the stale badge is correct before hydration. The client recomputes on its own tick.
   */
  serverNow: number
  overrideAuthors: Record<string, string>
  /** Drives which step-2/step-3 controls render. The database is the real gate. */
  viewerRole: AppRole
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('name')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Only non-default selections count as "active" — sort always has a value, so counting it
  // would show a permanent badge of 1 and stop meaning anything.
  const activeFilterCount =
    (category !== 'all' ? 1 : 0) + (status !== 'all' ? 1 : 0) + (sort !== 'name' ? 1 : 0)

  const staleness = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const row of rows) {
      map.set(
        `${row.sku}:${row.location}`,
        isStale(row.updated_at, serverNow, settings.stale_after_minutes),
      )
    }
    return map
  }, [rows, serverNow, settings.stale_after_minutes])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    const filtered = rows.filter((row) => {
      if (category !== 'all' && row.category !== category) return false
      if (!matchesStatus(row, status, staleness.get(`${row.sku}:${row.location}`) ?? false)) {
        return false
      }
      if (!needle) return true
      return (
        row.name.toLowerCase().includes(needle) || row.sku.toLowerCase().includes(needle)
      )
    })

    const sorted = [...filtered]
    if (sort === 'name') {
      sorted.sort((a, b) => byProductName(a.name, b.name))
    } else if (sort === 'least-available') {
      sorted.sort((a, b) => a.qty_available - b.qty_available || a.name.localeCompare(b.name))
    } else {
      sorted.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() ||
          a.name.localeCompare(b.name),
      )
    }
    return sorted
  }, [rows, query, category, status, sort, staleness])

  const filtersActive = query.trim() !== '' || category !== 'all' || status !== 'all'

  const clearFilters = () => {
    setQuery('')
    setCategory('all')
    setStatus('all')
  }

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className={styles.wrap}>
      {/* Sticky header keeps search reachable without scrolling back up. The filter chips
          are COLLAPSED by default: expanded, three wrapped groups fill the whole first
          screen on a phone and push every product card below the fold, so the list a rep
          opened the app to read is invisible until they scroll. Search is the common case;
          filters are the occasional one, and the toggle reports how many are active so a
          narrowed list is never mistaken for a short catalogue. */}
      <div className={styles.sticky}>
        <SearchField value={query} onChange={setQuery} />
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.filterToggle}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-controls="inventory-filters"
          >
            {filtersOpen ? 'Hide filters' : 'Filters'}
            {activeFilterCount > 0 ? (
              <span className={styles.filterCount}>{activeFilterCount}</span>
            ) : null}
          </button>
          {/* Result count, so an over-narrow filter is never mistaken for an empty catalogue. */}
          <p className={styles.count} aria-live="polite">
            {visible.length} of {rows.length} products
          </p>
        </div>
        <div id="inventory-filters" hidden={!filtersOpen}>
          <FilterBar
            categories={categories}
            category={category}
            onCategory={setCategory}
            status={status}
            onStatus={setStatus}
            sort={sort}
            onSort={setSort}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyText}>
            {query.trim() ? `No products match “${query.trim()}”.` : 'No products match those filters.'}
          </p>
          <button type="button" className={styles.clearButton} onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        <ul className={styles.list}>
          {visible.map((row) => {
            const key = `${row.sku}:${row.location}`
            return (
              <InventoryRow
                key={key}
                row={row}
                stale={staleness.get(key) ?? false}
                serverNow={serverNow}
                expanded={expanded.has(key)}
                onToggle={() => toggle(key)}
                overrideAuthor={row.override_by ? (overrideAuthors[row.override_by] ?? null) : null}
                viewerRole={viewerRole}
              />
            )
          })}
        </ul>
      )}

      {filtersActive && visible.length > 0 ? (
        <div className={styles.footer}>
          <button type="button" className={styles.clearButton} onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  )
}
