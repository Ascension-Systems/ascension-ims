'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Registers this device for push notifications — NATIVE APP ONLY.
 *
 * In a plain browser this renders nothing and does nothing: the dynamic import only runs when
 * Capacitor reports a native platform, so the web bundle never even asks for notification
 * permission (no permission-prompt spam for desktop users; Apple would reject a web prompt
 * that isn't user-initiated anyway).
 *
 * On the iOS app it: asks permission (first run only — iOS remembers), registers with APNs,
 * POSTs the device token to /api/push/register under the signed-in session, and deep-links
 * notification taps to the `url` carried in the payload (see lib/push.ts).
 *
 * Mounted from app/(app)/layout.tsx, i.e. only when signed in — so a token is always stored
 * against a real user and there is nothing to register on the login screen.
 */
export function PushRegister() {
  const router = useRouter()

  useEffect(() => {
    let cleanup: (() => void) | undefined

    ;(async () => {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor.isNativePlatform()) return
        const { PushNotifications } = await import('@capacitor/push-notifications')

        const regListener = await PushNotifications.addListener('registration', async ({ value }) => {
          try {
            await fetch('/api/push/register', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: value, platform: 'ios' }),
            })
          } catch {
            // Registration retries on next app start; never surface this to the user.
          }
        })

        const tapListener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          ({ notification }) => {
            const url = (notification.data as { url?: string } | undefined)?.url
            if (typeof url === 'string' && url.startsWith('/')) router.push(url)
          },
        )

        cleanup = () => {
          regListener.remove()
          tapListener.remove()
        }

        let { receive } = await PushNotifications.checkPermissions()
        if (receive === 'prompt') {
          ;({ receive } = await PushNotifications.requestPermissions())
        }
        if (receive === 'granted') await PushNotifications.register()
      } catch (e) {
        // Plugin missing (web build) or permission machinery failed — the app works fine without.
        console.warn('[push] registration skipped:', e)
      }
    })()

    return () => cleanup?.()
  }, [router])

  return null
}
