import { getProfile, requireUser } from '@/lib/auth'
import { getPromotions, getSheets, productNamesFor } from '@/lib/documents'
import { AppNav } from '@/components/app-nav'
import { DocumentUpload } from '@/components/document-upload'
import { SheetList } from '@/components/sheet-list'
import { DocActions } from '@/components/doc-actions'
import { DocViewer } from '@/components/doc-viewer'
import styles from './page.module.css'

/**
 * The resources hub — the client's other pillar. One mobile place for current promotions
 * (flyers) and the durable spec-sheet / price-sheet library, replacing the Dropbox and
 * weekly-email scatter.
 *
 * Reps VIEW ONLY. Admins get an upload form and per-item manage controls. Both read through the
 * cookie-bound client, so RLS (`documents_select_provisioned`) is the gate; the admin/rep split
 * below only decides which CONTROLS render, never what data is reachable.
 *
 * Files are never linked directly. "View" points at /api/documents/[id]/file, which mints a
 * short-lived signed URL after re-checking the caller against the database.
 */
export const dynamic = 'force-dynamic'

export default async function ResourcesPage() {
  await requireUser()
  const profile = await getProfile()
  const role = profile?.role ?? 'rep'
  const isAdmin = role === 'admin'

  const [promos, sheets] = await Promise.all([
    getPromotions(isAdmin),
    getSheets(undefined, isAdmin),
  ])
  const names = await productNamesFor([...promos, ...sheets].map((d) => d.product_sku))

  return (
    <main className={styles.main}>
      <AppNav role={role} />

      <div className={styles.intro}>
        <p className={styles.eyebrow}>Resources</p>
        <h1 className={styles.title}>Promotions &amp; spec sheets</h1>
        <p className={styles.subtitle}>
          Current promotions and the full spec-sheet library, always up to date. Everything here
          is the latest version — no more chasing emails.
        </p>
      </div>

      {isAdmin ? <DocumentUpload /> : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Current promotions</h2>
        {promos.length === 0 ? (
          <p className={styles.empty}>No promotions running right now.</p>
        ) : (
          <ul className={styles.promoGrid}>
            {promos.map((d) => {
              const hidden = isAdmin && !d.active
              return (
                <li key={d.id} className={`${styles.promo} ${hidden ? styles.promoHidden : ''}`}>
                  <div className={styles.promoBody}>
                    <p className={styles.promoName}>{d.title}</p>
                    {d.description ? <p className={styles.promoDesc}>{d.description}</p> : null}
                    {d.product_sku && names[d.product_sku] ? (
                      <p className={styles.promoMeta}>{names[d.product_sku]}</p>
                    ) : null}
                    {hidden ? <span className={styles.hiddenTag}>Hidden from reps</span> : null}
                  </div>
                  <div className={styles.promoActions}>
                    <DocViewer id={d.id} title={d.title} triggerClassName={styles.viewBtn} />
                    {isAdmin ? <DocActions id={d.id} active={d.active} /> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Spec sheets &amp; flyers</h2>
        <SheetList
          items={sheets.map((d) => ({
            id: d.id,
            title: d.title,
            description: d.description,
            productName: d.product_sku ? names[d.product_sku] ?? null : null,
            active: d.active,
            kind: d.kind,
          }))}
          isAdmin={isAdmin}
        />
      </section>
    </main>
  )
}
