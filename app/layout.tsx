import type { Metadata, Viewport } from 'next'
import './globals.css'

/**
 * NO COMPANY NAME, NO CLIENT NAME, NO INVENTED BRAND. "Inventory Portal" is a description,
 * not a brand (D2).
 */
export const metadata: Metadata = {
  title: 'Inventory Portal',
  description: 'Live stock availability for the sales team.',
  applicationName: 'Inventory Portal',
  appleWebApp: {
    capable: true,
    title: 'Inventory',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a2c4d',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
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
