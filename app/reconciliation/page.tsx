import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getProfile, requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { getPendingCommitments, namesForSkus } from '@/lib/commitments'
import { RelativeTime } from '@/components/relative-time'
import { SignOutButton } from '@/components/sign-out-button'
import { SyncButton } from '@/components/sync-button'
import styles from './page.module.css'

/**
 * Build-order step 3: the reconciliation queue.
 *
 * Every row is stock the portal knows is committed and QuickBooks does not yet reflect. That
 * makes this list the office's PAPERWORK BACKLOG, which is the point — it is independently
 * useful to staff rather than internal plumbing, and it is the thing that makes the delta
 * ledger legible to a human.
 *
 * DELTAS ARE RETIRED BY MATCHING, NEVER BY TIME. Nothing on this page ages a commitment out,
 * and there is no "clear" or "dismiss" control, deliberately: a commitment stops reducing
 * availability only when a synced source demonstrably includes it. A time-based reset is the
 * exact bug this project exists to prevent — a rep commits ten chairs Monday, the paperwork
 * reaches QuickBooks Wednesday, and a nightly reset makes them look available again Tuesday.
 *
 * ADMIN ONLY, and the database agrees: policy `commitments_select_own_or_admin` means a rep
 * hitting this URL directly would see only their own rows, not everyone's. The redirect below
 * is a convenience so a rep lands somewhere useful — it is not the access control.
 */

export const dynamic = 'force-dynamic'

export default async function ReconciliationPage() {
  await requireUser()
  const profile = await getProfile()
  if (!profile || profile.role !== 'admin') redirect('/inventory')

  const { rows, error } = await getPendingCommitments()
  const names = await namesForSkus(rows.map((r) => r.sku))

  // Rep emails, resolved through the anon client so RLS still decides. An admin may read
  // profiles; this is what turns a rep_id into a name someone can actually chase.
  const repEmails: Record<string, string> = {}
  const repIds = [...new Set(rows.map((r) => r.rep_id))]
  if (repIds.length > 0) {
    const supabase = await createClient()
    const { data } = await supabase.from('profiles').select('id, email').in('id', repIds)
    for (const p of data ?? []) repEmails[p.id as string] = p.email as string
  }

  const totalUnits = rows.reduce((n, r) => n + r.qty, 0)

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Admin</p>
          <h1 className={styles.title}>Reconciliation</h1>
          <p className={styles.subtitle}>
            Commitments recorded in the portal that QuickBooks has not confirmed yet. This is
            the paperwork still to be entered.
          </p>
        </div>
        <SignOutButton />
      </header>

      <nav className={styles.nav}>
        <Link className={styles.back} href="/inventory">
          Inventory
        </Link>
        <SyncButton />
      </nav>

      {error ? (
        <p className={styles.error}>The queue could not be loaded. Try again in a moment.</p>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing outstanding.</p>
          <p className={styles.emptyBody}>
            Every commitment recorded in the portal has been confirmed by the source. When a rep
            records a new one, it appears here until QuickBooks catches up.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <div className={styles.stat}>
              <span className={styles.statFigure}>{rows.length}</span>
              <span className={styles.statLabel}>
                {rows.length === 1 ? 'commitment' : 'commitments'} pending
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statFigure}>{totalUnits}</span>
              <span className={styles.statLabel}>units spoken for</span>
            </div>
          </div>

          <ul className={styles.list}>
            {rows.map((r) => (
              <li key={r.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <div className={styles.itemIdentity}>
                    <p className={styles.itemName}>{names[r.sku] ?? r.sku}</p>
                    <p className={styles.itemSku}>{r.sku}</p>
                  </div>
                  <div className={styles.itemQty}>
                    <span className={styles.qtyFigure}>{r.qty}</span>
                    <span className={styles.qtyLabel}>units</span>
                  </div>
                </div>

                <dl className={styles.meta}>
                  <div className={styles.metaRow}>
                    <dt>Recorded by</dt>
                    <dd>{repEmails[r.rep_id] ?? 'a rep'}</dd>
                  </div>
                  <div className={styles.metaRow}>
                    <dt>Waiting since</dt>
                    <dd>
                      <RelativeTime iso={r.created_at} />
                    </dd>
                  </div>
                  {r.note ? (
                    <div className={styles.metaRow}>
                      <dt>Note</dt>
                      <dd>{r.note}</dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>

          <p className={styles.footnote}>
            A commitment leaves this queue only when a sync from the source demonstrably
            includes it. Nothing here expires on a timer — that is what would let sold stock
            look available again.
          </p>
        </>
      )}
    </main>
  )
}
