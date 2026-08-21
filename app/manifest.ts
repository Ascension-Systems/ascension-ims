import type { MetadataRoute } from 'next'

/**
 * PWA manifest. Installable via "Add to Home Screen": no app-store review, no 100-device
 * provisioning cap, no 7-day sideload expiry, and updates reach all users instantly.
 *
 * Branded as Ascension IT IMS (reverses D2; Human-approved Ascension IT branding 2026-08-21).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ascension IT IMS',
    short_name: 'Ascension IT',
    description: 'Live stock availability for the sales team.',
    display: 'standalone',
    start_url: '/inventory',
    scope: '/',
    background_color: '#ffffff',
    theme_color: '#0a2c4d',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
