import { createClient } from '@/lib/supabase/server'

/**
 * Reads over public.commitments for the reconciliation queue (build-order step 3).
 *
 * COOKIE-BOUND ANON CLIENT, never service-role, so RLS decides what the caller sees. Policy
 * `commitments_select_own_or_admin` is `rep_id = auth.uid() OR is_admin()`, so the SAME query
 * returns a rep's own commitments and an admin's view of everyone's. A policy bug therefore
 * shows up as missing rows rather than as a silent leak of one rep's book to another.
 */

export type CommitmentRow = {
  id: string
  sku: string
  location: string
  qty: number
  rep_id: string
  state: 'pending' | 'confirmed_in_source' | 'retired'
  note: string | null
  source_ref: string | null
  created_at: string
  confirmed_at: string | null
}

/**
 * Pending commitments — the ones the source has NOT yet confirmed.
 *
 * This list IS the office's paperwork backlog, which is what makes the reconciliation view
 * independently useful to staff rather than internal plumbing. Every row here is stock the
 * portal knows is spoken for and QuickBooks does not.
 *
 * Ordered oldest first, deliberately: age is the signal. A commitment pending for two weeks
 * is the one that needs chasing, and it must not be buried under this morning's.
 */
export async function getPendingCommitments(): Promise<{
  rows: CommitmentRow[]
  error: string | null
}> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('commitments')
    .select('id, sku, location, qty, rep_id, state, note, source_ref, created_at, confirmed_at')
    .eq('state', 'pending')
    .order('created_at', { ascending: true })

  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as CommitmentRow[], error: null }
}

/** Product names for the SKUs in a commitment list, so the queue is readable. */
export async function namesForSkus(skus: string[]): Promise<Record<string, string>> {
  if (skus.length === 0) return {}
  const supabase = await createClient()
  const { data } = await supabase.from('products').select('sku, name').in('sku', [...new Set(skus)])
  const out: Record<string, string> = {}
  for (const p of data ?? []) out[p.sku as string] = p.name as string
  return out
}
