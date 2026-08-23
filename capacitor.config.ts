import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Native iOS shell for the portal. The app is a server-rendered Next.js app (server actions,
 * API routes, middleware) so it CANNOT be exported as static files and bundled — the iOS app
 * loads the live deployment in a native WebView instead.
 *
 * server.url MUST point at the deployed HTTPS origin. Set CAP_SERVER_URL before `npx cap sync`,
 * or edit the fallback string below, then re-sync. Until it points at a real deployment the app
 * will load the offline fallback in native-shell/www.
 *
 * appId is the bundle identifier registered in App Store Connect. Signing team is set in Xcode.
 */
const SERVER_URL = process.env.CAP_SERVER_URL || 'https://ascension-inventory.netlify.app'

const config: CapacitorConfig = {
  appId: 'com.ascensionitai.inventory',
  appName: 'AIT IMS',
  webDir: 'native-shell/www',
  // Paper (#fbfaf7), matching the web --paper. Sets the native WebView/scroll-view background so
  // the iOS rubber-band overscroll area shows paper instead of the default black. Takes effect on
  // the next Xcode build (native-level); the CSS html/body background handles the web layer live.
  backgroundColor: '#fbfaf7',
  server: {
    // A real https origin makes the WebView load the live app. cleartext stays false so only
    // https is ever loaded (App Transport Security). No trailing slash, no path.
    url: SERVER_URL.startsWith('https://') ? SERVER_URL : undefined,
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#fbfaf7',
  },
}

export default config
