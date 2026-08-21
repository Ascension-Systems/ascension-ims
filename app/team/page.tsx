import { redirect } from 'next/navigation'
import { getProfile, requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { InviteForm } from '@/components/invite-form'
import { ResetPassword } from '@/components/reset-password'
import { RelativeTime } from '@/components/relative-time'
import { AppNav } from '@/components/app-nav'
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
      .select('code, label, role, expires_at, max_uses, uses, is_active')
      .eq('is_active', true)
      .order('created_at', { ascending: false }),
  ])

  const rows = invites ?? []
  const pending = rows.filter((r) => !r.claimed_at)
  // Newest active code of each role (the list is already newest-first).
  const repCode = codes?.find((c) => c.role === 'rep') ?? null
  const adminCode = codes?.find((c) => c.role === 'admin') ?? null

  return (
    <main className={styles.main}>
      <AppNav role="admin" />

      <div className={styles.intro}>
        <p className={styles.eyebrow}>Admin</p>
        <h1 className={styles.title}>Team access</h1>
        <p className={styles.subtitle}>
          Add the reps who should have access, then share the code below. They set themselves
          up — no email links, nothing for you to send.
        </p>
      </div>

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

      <InviteForm
        repCode={repCode?.code ?? null}
        repUses={repCode?.uses ?? 0}
        repMaxUses={repCode?.max_uses ?? null}
        adminCode={adminCode?.code ?? null}
      />

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
              {/* Reset is only meaningful once someone has an account — i.e. has claimed. */}
              {r.claimed_at ? <ResetPassword email={r.email} /> : null}
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
