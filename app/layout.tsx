import type { Metadata, Viewport } from 'next'
import './globals.css'
import { NativeLinkHandler } from '@/components/native-link-handler'

/**
 * Branded to Plantation Prestige 2026-08-24 (Levon: "we branded to them" / "adopt some of
 * the colour schemes" from plantationprestige.com). Brand values live in app/globals.css
 * tokens, so re-skinning is a value change, not a component change.
 */
export const metadata: Metadata = {
  title: 'Plantation Prestige IMS',
  description: 'Live stock availability for the sales team.',
  applicationName: 'Plantation Prestige IMS',
  appleWebApp: {
    capable: true,
    title: 'Plantation Prestige',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#5c3d24',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme on <html> BEFORE first paint so there is no light-mode flash. Seeds
            from the saved choice, else the OS preference. The toggle (components/theme-toggle)
            updates the same attribute + localStorage at runtime. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t;try{window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.theme&&window.webkit.messageHandlers.theme.postMessage(t)}catch(e){}}catch(e){}})()`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* The rule targets pages/_document.js in the Pages Router. This IS the App Router
            root layout, which wraps every route, so the stylesheet loads once globally --
            exactly the outcome the rule asks for. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        {children}
        {/* Native-only: routes document links through an in-app browser sheet that has a Done
            button, so tapping "View" in the iOS app is no longer a one-way trip. Renders
            nothing and attaches no listener on the web. */}
        <NativeLinkHandler />
        {/*
          Service worker registration. The worker passes every fetch straight through to the
          network and caches nothing; its only job is to satisfy Chrome's installability
          requirement for a fetch handler. It contains no push handler and no VAPID key --
          real Web Push is out of scope and no notification permission prompt is faked.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </body>
    </html>
  )
}
