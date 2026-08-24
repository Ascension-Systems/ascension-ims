'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Re-syncs the app when it returns to the foreground after being backgrounded.
 *
 * On iOS the WKWebView suspends while the app is in the background; on resume the client router
 * is left stale, so tapping a tab changes the tab but the server-rendered content below never
 * re-fetches ("locked up"). Listening for the page becoming visible again and refreshing fixes
 * that — and, for an inventory app, means a rep always sees current stock on resume rather than
 * a snapshot from whenever they last had it open.
 *
 *   • away a short moment  → nothing (a quick app-switch didn't suspend anything)
 *   • away 15s–5min        → router.refresh() (re-fetch server data, re-sync the router; no flash)
 *   • away > 5min          → full reload (deep reset; guaranteed-fresh after a long absence)
 */
const SOFT_MS = 15 * 1000
const HARD_MS = 5 * 60 * 1000

export function ResumeRefresh() {
  const router = useRouter()
  useEffect(() => {
    let hiddenAt: number | null = null

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt == null) return
      const away = Date.now() - hiddenAt
      hiddenAt = null
      if (away > HARD_MS) window.location.reload()
      else if (away > SOFT_MS) router.refresh()
    }

    // bfcache restore (rare in the webview, but harmless to cover)
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) router.refresh()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [router])

  return null
}
