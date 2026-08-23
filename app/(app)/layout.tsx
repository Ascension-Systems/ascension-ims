import { requireUser, getProfile } from '@/lib/auth'
import { AppNav } from '@/components/app-nav'

/**
 * Shared layout for every signed-in screen. The nav is rendered HERE, once, so it stays fixed
 * across tab navigations instead of re-mounting inside each page — which is what let the tab row
 * flicker/"break" when switching screens. With the nav in the layout, Next keeps it mounted and
 * only swaps the page content (showing loading.tsx while the next page loads).
 *
 * Role comes from the real profile, so the correct tab set shows on every page (each page still
 * enforces its own access; this is presentation only).
 */
export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser()
  const profile = await getProfile()
  const role = profile?.role === 'admin' ? 'admin' : 'rep'
  return (
    <>
      <AppNav role={role} />
      {children}
    </>
  )
}
