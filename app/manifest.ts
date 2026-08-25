import type { MetadataRoute } from 'next'

/**
 * PWA manifest. Installable via "Add to Home Screen": no app-store review, no 100-device
 * provisioning cap, no 7-day sideload expiry, and updates reach all users instantly.
 *
 * Branded to Plantation Prestige 2026-08-24 (Levon: "we branded to them").
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Plantation Prestige IMS',
    short_name: 'Plantation Prestige',
    description: 'Live stock availability for the sales team.',
    display: 'standalone',
    start_url: '/inventory',
    scope: '/',
    background_color: '#ffffff',
    theme_color: '#5c3d24',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
