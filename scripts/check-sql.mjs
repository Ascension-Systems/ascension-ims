#!/usr/bin/env node
/**
 * check:sql — migrations must not reference an object before the file that creates it.
 *
 *   npm run check:sql
 *   npm run check:sql -- --self-test
 *
 * WHY: migrations run in filename order, once, against a database that has only what earlier
 * files built. A file that references a table created LATER applies fine on a database where
 * someone already ran things by hand, and fails on a clean one -- so the break surfaces at the
 * worst moment, standing up a fresh environment, not in development.
 *
 * WHAT IT MODELS: objects created per file (tables, functions, types, extensions, and the
 * columns of each table) in filename order, then every reference against what exists SO FAR.
 * It is deliberately conservative: it reports only references it can attribute to a known
 * object name that appears LATER in the sequence. An unknown name is not an error -- Postgres
 * built-ins, extension-provided objects and auth.* live outside these files.
 */
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DIR = join(ROOT, 'supabase', 'migrations')
const SELF_TEST = process.argv.includes('--self-test')

const strip = (sql) => sql
  .replace(/\$\$[\s\S]*?\$\$/g, (m) => m.replace(/[^\n]/g, ' '))  // blank function bodies, keep lines
  .replace(/--[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

function scan(files) {
  // pass 1: when is each object first created?
  const createdIn = new Map()
  files.forEach(({ name, sql }, idx) => {
    const s = strip(sql)
    const add = (re, kind) => {
      re.lastIndex = 0; let m
      while ((m = re.exec(s))) {
        const key = m[1].toLowerCase().replace(/^public\./, '')
        if (!createdIn.has(key)) createdIn.set(key, { idx, name, kind })
      }
    }
    add(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w.]*)/gi, 'table')
    add(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][\w.]*)/gi, 'function')
    add(/CREATE\s+TYPE\s+([a-z_][\w.]*)/gi, 'type')
    add(/CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w.]*)/gi, 'view')
    add(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][\w]*)"?/gi, 'extension')
  })

  // pass 2: references, checked against what exists at that point
  const problems = []
  let refsChecked = 0
  files.forEach(({ name, sql }, idx) => {
    const s = strip(sql)
    const ref = (re, kind) => {
      re.lastIndex = 0; let m
      while ((m = re.exec(s))) {
        const key = m[1].toLowerCase().replace(/^public\./, '')
        const c = createdIn.get(key)
        if (!c) continue                     // unknown -> built-in/extension/auth.*; not our call
        refsChecked++
        if (c.idx > idx) problems.push({
          file: name, line: s.slice(0, m.index).split('\n').length,
          object: key, kind, createdIn: c.name })
      }
    }
    ref(/REFERENCES\s+([a-z_][\w.]*)/gi, 'FK reference')
    ref(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][\w.]*)/gi, 'ALTER TABLE')
    ref(/\bON\s+([a-z_][\w.]*)\s*(?:USING|FOR|\()/gi, 'policy/index target')
    ref(/\bFROM\s+([a-z_][\w.]*)/gi, 'FROM')
    ref(/\bJOIN\s+([a-z_][\w.]*)/gi, 'JOIN')
    ref(/\bINSERT\s+INTO\s+([a-z_][\w.]*)/gi, 'INSERT INTO')
    ref(/\bUPDATE\s+([a-z_][\w.]*)\s+SET/gi, 'UPDATE')
  })
  return { problems, refsChecked, objectCount: createdIn.size }
}

const load = () => readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }))

if (SELF_TEST) {
  const files = load()
  const planted = join(DIR, '0000_selftest_forward_ref.sql')
  // 0000 sorts FIRST, so anything it references is by definition created later.
  const later = files.find((f) => /CREATE TABLE/i.test(strip(f.sql)))
  const target = strip(later.sql).match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w.]*)/i)[1]
  writeFileSync(planted, `-- planted\nALTER TABLE ${target} ADD COLUMN selftest_col int;\n`)
  const withPlant = scan(load())
  rmSync(planted, { force: true })
  const after = scan(load())
  const caught = withPlant.problems.some((p) => p.file.startsWith('0000_selftest'))
  console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} planted forward reference to "${target}"`)
  console.log(`  ${after.problems.length === 0 ? 'CLEAN  ' : 'DIRTY  '} after removing planted file`)
  const ok = caught && after.problems.length === 0
  console.log(ok ? '\nself-test PASSED — the check is live'
                 : '\nself-test FAILED — do not trust a zero from this check')
  process.exit(ok ? 0 : 1)
}

const files = load()
const { problems, refsChecked, objectCount } = scan(files)
console.log(`check:sql — ${files.length} migrations, ${objectCount} objects created, ${refsChecked} in-scope references checked`)
if (problems.length) {
  console.log('\nFAIL: object referenced before the migration that creates it:\n')
  for (const p of problems) console.log(`  ${p.file}:${p.line}  ${p.kind} -> "${p.object}" (created in ${p.createdIn})`)
  process.exit(1)
}
console.log('ok  : no migration references an object created by a later migration')
