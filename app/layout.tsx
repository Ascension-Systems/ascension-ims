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
  themeColor: '#ffffff',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
