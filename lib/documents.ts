import { createClient } from '@/lib/supabase/server'

/**
 * Reads over public.documents for the resources hub (promotions + spec sheets).
 *
 * COOKIE-BOUND ANON CLIENT, never service-role, so RLS decides what the caller sees. Policy
 * `documents_select_provisioned` gates every read to a provisioned account, so an unprovisioned
 * signup or a raw anon token reads nothing here. A policy bug shows up as missing rows, never a
 * leak.
 */

export type DocKind = 'promotion' | 'spec_sheet' | 'flyer' | 'price_sheet'

export type DocumentRow = {
  id: string
  kind: DocKind
  title: string
  description: string | null
  product_sku: string | null
  storage_path: string
  mime_type: string
  size_bytes: number
  active: boolean
  starts_at: string | null
  ends_at: string | null
  created_at: string
}

const COLS =
  'id, kind, title, description, product_sku, storage_path, mime_type, size_bytes, active, starts_at, ends_at, created_at'

/** True when a promotion is live right now: active and inside any start/end window. */
function inWindow(d: DocumentRow, now: number): boolean {
  return (
    (!d.starts_at || Date.parse(d.starts_at) <= now) &&
    (!d.ends_at || Date.parse(d.ends_at) >= now)
  )
}

/**
 * Current promotions. Reps get only the live ones (active + in window); an admin passes
 * includeHidden to also see scheduled/expired/deactivated ones so they can manage them.
 */
export async function getPromotions(includeHidden = false): Promise<DocumentRow[]> {
  const supabase = await createClient()
  let q = supabase.from('documents').select(COLS).eq('kind', 'promotion')
  if (!includeHidden) q = q.eq('active', true)
  const { data } = await q.order('created_at', { ascending: false })
  const rows = (data ?? []) as DocumentRow[]
  if (includeHidden) return rows
  const now = Date.now()
  return rows.filter((d) => inWindow(d, now))
}

/**
 * Spec sheets, flyers and price sheets — the durable reference material, title-searchable.
 * Reps get active only; an admin passes includeHidden to manage deactivated ones.
 */
export async function getSheets(query?: string, includeHidden = false): Promise<DocumentRow[]> {
  const supabase = await createClient()
  let q = supabase
    .from('documents')
    .select(COLS)
    .in('kind', ['spec_sheet', 'flyer', 'price_sheet'])
  if (!includeHidden) q = q.eq('active', true)
  if (query && query.trim()) {
    // Escape the LIKE metacharacters so a search for "50%" is a literal, not a wildcard.
    const safe = query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)
    q = q.ilike('title', `%${safe}%`)
  }
  const { data } = await q.order('title', { ascending: true })
  return (data ?? []) as DocumentRow[]
}

/** Product names for the SKUs referenced by a document list, so cards can name the item. */
export async function productNamesFor(skus: (string | null)[]): Promise<Record<string, string>> {
  const list = [...new Set(skus.filter((s): s is string => !!s))]
  if (list.length === 0) return {}
  const supabase = await createClient()
  const { data } = await supabase.from('products').select('sku, name').in('sku', list)
  const out: Record<string, string> = {}
  for (const p of data ?? []) out[p.sku as string] = p.name as string
  return out
}
