import { getProfile, requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { getSettings } from '@/lib/settings'
import { categoriesOf, getInventory } from '@/lib/inventory'
import { InventoryList } from '@/components/inventory-list'
import styles from './page.module.css'

/**
 * The inventory view. It is the app: there is no other authenticated screen in step 1.
 *
 * Rendered through the COOKIE-BOUND ANON CLIENT, never the service-role client, so this page
 * is subject to RLS. A policy bug therefore shows up as missing data rather than as a silent
 * leak.
 *
 * requireUser() is called here rather than relying on middleware. Middleware is convenience,
 * not access control.
 */

export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  await requireUser()

  const [profile, settings, { rows, error }] = await Promise.all([
    getProfile(),
    getSettings(),
    getInventory(),
  ])
  // Falls back to 'rep' -- the LEAST privileged role -- if the profile cannot be read, so a
  // failure here hides admin controls rather than revealing them. The database refuses the
  // action regardless; this only decides what is on screen.
  const viewerRole = profile?.role ?? 'rep'

  // The server's clock, passed down so the first paint computes staleness server-side and
  // the stale badge is correct before hydration.
  const serverNow = Date.now()

  /**
   * Resolve override authors through the ANON client, so RLS decides what the viewer may
   * see. A rep may read only their own profile row, so for a rep this resolves to nothing and
   * the card falls back to "internal staff" rather than leaking a colleague's address. An
   * admin sees the email.
   */
  const authorIds = [...new Set(rows.map((r) => r.override_by).filter((id): id is string => Boolean(id)))]
  const overrideAuthors: Record<string, string> = {}
  if (authorIds.length > 0) {
    const supabase = await createClient()
    const { data } = await supabase.from('profiles').select('id, email').in('id', authorIds)
    for (const profile of data ?? []) {
      overrideAuthors[profile.id as string] = profile.email as string
    }
  }

  return (
    <main className={styles.main}>

      <div className={styles.intro}>
        <h1 className={styles.title}>Inventory</h1>
        <p className={styles.subtitle}>
          Available = on hand minus quantity on open sales orders in QuickBooks.
        </p>
      </div>

      {error ? (
        <p className={styles.error}>
          Inventory could not be loaded. Try again in a moment.
        </p>
      ) : (
        <InventoryList
          rows={rows}
          categories={categoriesOf(rows)}
          settings={settings}
          serverNow={serverNow}
          overrideAuthors={overrideAuthors}
          viewerRole={viewerRole}
        />
      )}
    </main>
  )
}
