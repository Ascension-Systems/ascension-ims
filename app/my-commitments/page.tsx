import { requireUser } from '@/lib/auth'
import { getMyCommitments, namesForSkus } from '@/lib/commitments'
import { RelativeTime } from '@/components/relative-time'
import { AppNav } from '@/components/app-nav'
import styles from '@/app/reconciliation/page.module.css'

/**
 * A rep's own book: the stock they have spoken for. Reps can record a commitment anywhere in
 * the inventory list, but until now had no single screen showing what they hold — this is it.
 *
 * Every viewer sees only their own rows (getMyCommitments pins rep_id to auth.uid()), so an
 * admin opening this sees THEIR commitments, not the company's; the reconciliation queue is the
 * everyone view. Available to any signed-in user, which is why there is no admin redirect here.
 *
 * "Awaiting QuickBooks" vs "In QuickBooks" is the whole story: a commitment holds stock until a
 * synced source demonstrably includes it. Nothing here ages out on a timer — that is the bug
 * this product exists to prevent.
 */
export const dynamic = 'force-dynamic'

export default async function MyCommitmentsPage() {
  await requireUser()
  const { pending, settled, error } = await getMyCommitments()

  const names = await namesForSkus([...pending, ...settled].map((r) => r.sku))
  const pendingUnits = pending.reduce((n, r) => n + r.qty, 0)

  return (
    <main className={styles.main}>
      <AppNav role="rep" />

      <div className={styles.intro}>
        <p className={styles.eyebrow}>Yours</p>
        <h1 className={styles.title}>My commitments</h1>
        <p className={styles.subtitle}>
          Stock you have spoken for. Each one holds inventory until QuickBooks confirms it —
          nothing here disappears on its own.
        </p>
      </div>

      {error ? (
        <p className={styles.error}>Your commitments could not be loaded. Try again in a moment.</p>
      ) : pending.length === 0 && settled.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing yet.</p>
          <p className={styles.emptyBody}>
            When you commit stock from the inventory list, it appears here so you can see
            everything you are holding in one place.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <div className={styles.stat}>
              <span className={styles.statFigure}>{pending.length}</span>
              <span className={styles.statLabel}>
                {pending.length === 1 ? 'commitment' : 'commitments'} active
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statFigure}>{pendingUnits}</span>
              <span className={styles.statLabel}>units held</span>
            </div>
          </div>

          {pending.length > 0 ? (
            <ul className={styles.list}>
              {pending.map((r) => (
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
                      <dt>Status</dt>
                      <dd>
                        <span className={styles.badge}>Awaiting QuickBooks</span>
                      </dd>
                    </div>
                    <div className={styles.metaRow}>
                      <dt>Committed</dt>
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
          ) : null}

          {settled.length > 0 ? (
            <>
              <p className={styles.sectionLabel}>Confirmed in QuickBooks</p>
              <ul className={styles.list}>
                {settled.map((r) => (
                  <li key={r.id} className={`${styles.item} ${styles.itemSettled}`}>
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
                        <dt>Status</dt>
                        <dd>
                          <span className={`${styles.badge} ${styles.badgeSettled}`}>
                            ✓ In QuickBooks
                          </span>
                        </dd>
                      </div>
                      <div className={styles.metaRow}>
                        <dt>Confirmed</dt>
                        <dd>
                          {r.confirmed_at ? <RelativeTime iso={r.confirmed_at} /> : '—'}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className={styles.footnote}>
            A commitment moves to “In QuickBooks” only when a sync from the source demonstrably
            includes it — never on a timer. That is what keeps sold stock from looking available
            again.
          </p>
        </>
      )}
    </main>
  )
}
