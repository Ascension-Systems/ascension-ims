import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST -> bulk catalogue/stock import from a spreadsheet export.
 *
 * "How do they get all the data in? ... Is there even any way to link an Excel file back to
 * this, or do they need to repopulate all this data?" (Levon, 2026-08-24). Their catalogue
 * lives in Excel and QuickBooks today, so the answer has to be "export a CSV and drop it in".
 *
 * CSV rather than .xlsx on purpose: every spreadsheet exports CSV, it needs no parsing library
 * in the bundle, and it is inspectable — an admin can see exactly what they are about to load.
 *
 * DRY RUN BY DEFAULT IS NOT ASSUMED — the caller passes `commit: true` to write. A preview pass
 * returns the same per-row verdicts without touching the database, so the operator sees what an
 * import would do before it does it. That matters when the file is someone's live price list.
 *
 * Rows are validated individually: one malformed line reports itself and is skipped, rather
 * than failing an otherwise good 400-row import. Quantities are optional — a file that only
 * carries names still updates names.
 */

/** Minimal RFC-4180-ish CSV parse: handles quoted fields, embedded commas and doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const s = text.replace(/\r\n?/g, '\n')

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

/** Accept the header spellings a real export actually produces. */
const HEADERS: Record<string, string[]> = {
  sku: ['sku', 'item', 'item no', 'item number', 'part', 'part number', 'product code'],
  name: ['name', 'description', 'product', 'product name', 'item name'],
  category: ['category', 'type', 'group', 'product category'],
  qty_on_hand: ['qty on hand', 'on hand', 'quantity on hand', 'qty_on_hand', 'onhand', 'qty'],
  qty_committed: ['qty committed', 'committed', 'on sales order', 'qty_committed'],
  qty_incoming: ['qty incoming', 'incoming', 'on purchase order', 'on order', 'qty_incoming'],
}

function mapHeader(cell: string): string | null {
  const norm = cell.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  for (const [field, aliases] of Object.entries(HEADERS)) if (aliases.includes(norm)) return field
  return null
}

const int = (v: string | undefined) => {
  if (v === undefined) return null
  const t = v.replace(/[,$\s]/g, '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

export async function POST(request: Request) {
  const admin = await requireAdmin()
  if (!admin.ok) {
    const status = admin.reason === 'NOT_AUTHENTICATED' ? 401 : 403
    return NextResponse.json(
      { error: admin.reason, message: status === 401 ? 'Sign in to continue.' : 'This action requires an admin account.' },
      { status },
    )
  }

  const rl = checkRateLimit('inventory:import', admin.profile.id, 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'Too many imports. Wait a minute.' }, { status: 429 })
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 5_000_000) {
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Keep the file under 5 MB.' }, { status: 413 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Expected a JSON body.' }, { status: 400 })
  }
  const { csv, commit } = (body ?? {}) as { csv?: unknown; commit?: unknown }
  if (typeof csv !== 'string' || !csv.trim()) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'Paste or upload a CSV first.' }, { status: 400 })
  }

  const grid = parseCsv(csv)
  if (grid.length < 2) {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'That file has a header but no rows.' }, { status: 400 })
  }

  const headerRow = grid[0] ?? []
  const columns = headerRow.map(mapHeader)
  if (!columns.includes('sku')) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', message: 'No SKU column found. Expected a column named SKU, Item, or Product Code.' },
      { status: 400 },
    )
  }

  const MAX_ROWS = 5000
  const dataRows = grid.slice(1, MAX_ROWS + 1)
  const truncated = grid.length - 1 > MAX_ROWS

  const supabase = await createClient()
  const { data: existing } = await supabase.from('products').select('sku')
  const known = new Set((existing ?? []).map((p) => p.sku as string))

  const results: { sku: string; action: string; detail?: string }[] = []
  let created = 0, updated = 0, skipped = 0

  for (const cells of dataRows) {
    const rec: Record<string, string> = {}
    columns.forEach((field, i) => { if (field) rec[field] = (cells[i] ?? '').trim() })

    const sku = rec.sku?.trim()
    if (!sku) { skipped += 1; results.push({ sku: '(blank)', action: 'skipped', detail: 'no SKU' }); continue }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/.test(sku)) {
      skipped += 1
      results.push({ sku, action: 'skipped', detail: 'SKU has unsupported characters' })
      continue
    }

    const isNew = !known.has(sku)
    if (isNew && !rec.name) {
      skipped += 1
      results.push({ sku, action: 'skipped', detail: 'new SKU needs a name' })
      continue
    }

    if (commit === true) {
      // INSERT for a new sku, UPDATE for an existing one — never a blind upsert. An upsert of
      // `{ sku }` alone takes the insert path for a quantities-only file ("SKU,On Hand") and
      // violates products.name NOT NULL, which failed every stock-only import.
      let productError: string | null = null
      if (isNew) {
        const ins = await supabase.from('products').insert({
          sku,
          name: rec.name,
          // products.category is NOT NULL; a file may legitimately omit it.
          category: rec.category || 'Uncategorised',
        })
        productError = ins.error?.message ?? null
      } else if (rec.name || rec.category) {
        const patch: Record<string, unknown> = {}
        if (rec.name) patch.name = rec.name
        if (rec.category) patch.category = rec.category
        const upd = await supabase.from('products').update(patch).eq('sku', sku)
        productError = upd.error?.message ?? null
      }
      // else: nothing to change on the product itself — quantities only. Not an error.
      if (productError) {
        skipped += 1
        results.push({ sku, action: 'failed', detail: productError })
        continue
      }

      const onHand = int(rec.qty_on_hand)
      const committedQty = int(rec.qty_committed)
      const incoming = int(rec.qty_incoming)
      if (onHand !== null || committedQty !== null || incoming !== null) {
        const invPatch: Record<string, unknown> = { sku, location: 'default', updated_at: new Date().toISOString() }
        if (onHand !== null) invPatch.qty_on_hand = onHand
        if (committedQty !== null) invPatch.qty_committed = committedQty
        if (incoming !== null) invPatch.qty_incoming = incoming
        const iu = await supabase.from('inventory').upsert(invPatch, { onConflict: 'sku,location' })
        if (iu.error) {
          results.push({ sku, action: isNew ? 'created' : 'updated', detail: `quantities not applied: ${iu.error.message}` })
          isNew ? (created += 1) : (updated += 1)
          continue
        }
      }
    }

    if (isNew) { created += 1; known.add(sku); results.push({ sku, action: commit === true ? 'created' : 'would create' }) }
    else { updated += 1; results.push({ sku, action: commit === true ? 'updated' : 'would update' }) }
  }

  return NextResponse.json({
    ok: true,
    committed: commit === true,
    columnsDetected: columns.filter(Boolean),
    rows: dataRows.length,
    truncated,
    created,
    updated,
    skipped,
    // Bounded so a 5,000-row file cannot return a 5,000-entry payload to a phone.
    sample: results.slice(0, 25),
  })
}
