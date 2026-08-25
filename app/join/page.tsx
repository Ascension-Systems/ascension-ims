import { JoinForm } from '@/components/join-form'
import Link from 'next/link'
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

export const metadata = { title: 'Set up your access — AIT IMS' }

export default function JoinPage() {
  return (
    <main className={styles.main}>
      <BrandMark className={styles.brandMark} alt="Plantation Prestige" />
      <h1 className={styles.heading}>Set up your access</h1>
      <p className={styles.body}>
        {/* This said "there is no password and nothing to wait for by email" -- true under the
            old magic-link flow, and directly contradicted by the two password fields the reader
            is looking at. Onboarding now sets a password; the copy says so. */}
        Enter the code you were given, your work email address, and a password you will use from
        now on. You will be signed in straight away — nothing to wait for by email.
      </p>
      <JoinForm />
      {/* Without this the page was a one-way street: a rep who opened it by mistake, or who
          already has an account, had no route back to sign-in. */}
      <p className={styles.body}>
        Already set up? <Link href="/login">Sign in instead</Link>.
      </p>
    </main>
  )
}
