/*
 * Minimal service worker.
 *
 * Its ONLY job is to satisfy Chrome's installability requirement for a fetch handler. It
 * passes every request straight through to the network and caches nothing -- an inventory
 * portal serving a cached availability figure would be worse than showing nothing at all,
 * because a stale number that looks live is exactly the failure this project exists to
 * prevent.
 *
 * There is NO PUSH HANDLER and NO VAPID KEY here. Real Web Push is out of scope, and no
 * notification permission prompt is faked. iOS installs from the manifest alone.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Network passthrough. Deliberately does not call event.respondWith, so the browser
  // handles the request exactly as it would with no worker installed.
})
