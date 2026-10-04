/**
 * The EFFECTIVE migration-source definition of an object, for the STATIC assertions.
 *
 * A static check that reads a fixed file goes stale the moment a later migration replaces the
 * object: 1.12 used to read 0008 after 0025 had dropped and recreated v_inventory, and 4.13
 * read 0010 after both 0013 and 0025 had replaced apply_inventory_sync. Either could keep
 * passing while the definition actually applied had lost the property being asserted.
 *
 * So: walk supabase/migrations in the same numeric order they are applied, strip `--` line
 * comments (migrations document old forms in comments), and return the LAST statement that
 * creates the object, plus the file it came from for the diagnostic.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './config.mjs'

const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations')

const stripLineComments = (sql) => sql.replace(/--[^\n]*/g, '')

/**
 * @param {RegExp} startPattern  matches the start of the defining statement
 * @param {(sql: string, start: number) => number} endOf  index just past the statement's end
 * @returns {{ file: string, text: string } | null}
 */
function latestDefinition(startPattern, endOf) {
  let found = null
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = stripLineComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    const re = new RegExp(startPattern.source, startPattern.flags.includes('g') ? startPattern.flags : `${startPattern.flags}g`)
    let m
    while ((m = re.exec(sql))) {
      const end = endOf(sql, m.index)
      if (end > m.index) found = { file, text: sql.slice(m.index, end) }
    }
  }
  return found
}

/** The last `CREATE [OR REPLACE] VIEW public.v_inventory ... ;` applied. */
export function latestViewDefinition() {
  return latestDefinition(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+public\.v_inventory\b/i, (sql, start) => {
    const semi = sql.indexOf(';', start)
    return semi < 0 ? -1 : semi + 1
  })
}

/** The last `CREATE [OR REPLACE] FUNCTION public.<name>(` ... `$$;` applied. */
export function latestFunctionDefinition(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return latestDefinition(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${escaped}\\s*\\(`, 'i'), (sql, start) => {
    const open = sql.indexOf('$$', start)
    if (open < 0) return -1
    const close = sql.indexOf('$$', open + 2)
    return close < 0 ? -1 : close + 2
  })
}
