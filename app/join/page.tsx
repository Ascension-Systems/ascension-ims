import { JoinForm } from '@/components/join-form'
import { BrandMark } from '@/components/logo'
import styles from '@/app/message.module.css'

/**
 * Self-serve onboarding. A rep enters the shared code plus their own email and is signed in
 * immediately -- no email, no link, no waiting.
 *
 * The code alone grants nothing: it must match an address an admin already invited. See
 * app/api/enroll/route.ts and migration 0014 for why that pairing is load-bearing.
 */
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Join — Inventory Portal' }

export default function JoinPage() {
  return (
    <main className={styles.main}>
      <BrandMark className={styles.brandMark} alt="Ascension IT" />
      <h1 className={styles.heading}>Set up your access</h1>
      <p className={styles.body}>
        Enter the code you were given and your work email address. You will be signed in
        straight away — there is no password and nothing to wait for by email.
      </p>
      <JoinForm />
    </main>
  )
}
