'use client'

import { useEffect } from 'react'

/**
 * Document links (`/api/documents/<id>/file`) carry `target="_blank"`, which is correct on the
 * web: the file opens in a new tab and the portal stays put behind it.
 *
 * Inside the Capacitor WKWebView there are no tabs. `target="_blank"` is either dropped or
 * navigates in place, and a rep who taps "View" lands on a bare PDF with no app chrome and no
 * back control — the dead end reported from the phone but never reproducible in a browser.
 *
 * So on native only, intercept those clicks and hand the URL to @capacitor/browser, which
 * presents SFSafariViewController *over* the app with a Done button. The app is still mounted
 * underneath; dismissing returns exactly where the rep was.
 *
 * On the web this listener does nothing at all and the normal anchor behaviour stands.
 */
export function NativeLinkHandler() {
  useEffect(() => {
    let cancelled = false
    let detach: (() => void) | undefined

    ;(async () => {
      const { Capacitor } = await import('@capacitor/core')
      if (!Capacitor.isNativePlatform() || cancelled) return

      const { Browser } = await import('@capacitor/browser')

      const onClick = (event: MouseEvent) => {
        // Let the browser handle anything the user redirected deliberately.
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

        const anchor = (event.target as Element | null)?.closest?.('a')
        if (!anchor) return

        const href = anchor.getAttribute('href')
        if (!href) return

        // Only files. In-app navigation must keep using the router.
        if (!/^\/api\/documents\/[^/]+\/file\/?$/.test(href)) return

        event.preventDefault()
        // Resolve against the deployed origin the WebView is showing, not a bare path.
        void Browser.open({ url: new URL(href, window.location.origin).toString() })
      }

      document.addEventListener('click', onClick)
      detach = () => document.removeEventListener('click', onClick)
    })()

    return () => {
      cancelled = true
      detach?.()
    }
  }, [])

  return null
}
