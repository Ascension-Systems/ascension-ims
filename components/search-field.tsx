'use client'

import { useRef } from 'react'
import { CloseGlyph } from '@/components/icons'
import styles from './search-field.module.css'

/**
 * 56px search input, sticky at the top of the list. Matches sku OR name, case-insensitive
 * substring.
 *
 * No debounce: the array is in memory, so a keystroke costs a filter over ~97 objects. A
 * round trip per keystroke on a phone with poor signal is worse than every alternative.
 */
export function SearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className={styles.wrap}>
      <label htmlFor="inventory-search" className="srOnly">
        Search products by name or SKU
      </label>
      <input
        id="inventory-search"
        ref={inputRef}
        className={styles.input}
        type="search"
        inputMode="search"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Search name or SKU"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <CloseGlyph />
          <span className="srOnly">Clear search</span>
        </button>
      ) : null}
    </div>
  )
}
