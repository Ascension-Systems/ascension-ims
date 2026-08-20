import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getProfile, requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { InviteForm } from '@/components/invite-form'
import { RelativeTime } from '@/components/relative-time'
import { SignOutButton } from '@/components/sign-out-button'
import styles from '@/app/reconciliation/page.module.css'

/**
 * Admin: the rep roster and the enrollment code.
 *
 * Admin only, and the database agrees -- `invited_reps_admin_all` and
 * `enrollment_codes_admin_all` are both `USING (public.is_admin())`, so a rep who reaches this
 * URL directly reads nothing. The redirect is a convenience, not the access control.
 */
export const dynamic = 'force-dynamic'

export default async function TeamPage() {
  await requireUser()
  const profile = await getProfile()
  if (!profile || profile.role !== 'admin') redirect('/inventory')

  const supabase = await createClient()
  const [{ data: invites }, { data: codes }] = await Promise.all([
    supabase
      .from('invited_reps')
      .select('email, invited_at, claimed_at')
      .order('claimed_at', { ascending: true, nullsFirst: true })
      .order('invited_at', { ascending: true }),
    supabase
      .from('enrollment_codes')
      .select('code, label, expires_at, max_uses, uses, is_active')
      .eq('is_active', true)
      .order('created_at', { ascending: false }),
  ])

  const rows = invites ?? []
  const pending = rows.filter((r) => !r.claimed_at)
  const active = codes?.[0] ?? null

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Admin</p>
          <h1 className={styles.title}>Team access</h1>
          <p className={styles.subtitle}>
            Add the reps who should have access, then share the code below. They set themselves
            up — no email links, nothing for you to send.
          </p>
        </div>
        <SignOutButton />
      </header>

      <nav className={styles.nav}>
        <Link className={styles.back} href="/inventory">
          Inventory
        </Link>
        <Link className={styles.back} href="/reconciliation">
          Reconciliation
        </Link>
      </nav>

      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.statFigure}>{rows.length - pending.length}</span>
          <span className={styles.statLabel}>set up</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statFigure}>{pending.length}</span>
          <span className={styles.statLabel}>not yet</span>
        </div>
      </div>

      <InviteForm code={active?.code ?? null} uses={active?.uses ?? 0} maxUses={active?.max_uses ?? null} />

      {rows.length > 0 ? (
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.email} className={styles.item}>
              <div className={styles.itemHead}>
                <div className={styles.itemIdentity}>
                  <p className={styles.itemName}>{r.email}</p>
                  <p className={styles.itemSku}>
                    {r.claimed_at ? 'Set up' : 'Waiting to set up'}
                  </p>
                </div>
              </div>
              <dl className={styles.meta}>
                <div className={styles.metaRow}>
                  <dt>{r.claimed_at ? 'Set up' : 'Added'}</dt>
                  <dd>
                    <RelativeTime iso={r.claimed_at ?? r.invited_at} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No reps added yet.</p>
          <p className={styles.emptyBody}>
            Paste the list of work email addresses above. Each person can then set themselves up
            with the access code.
          </p>
        </div>
      )}
    </main>
  )
}
