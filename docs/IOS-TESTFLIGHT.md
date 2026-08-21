# Ascension Inventory — iOS build & App Store Connect upload

The iOS app is a native **Capacitor** shell (Swift Package Manager, no CocoaPods) that loads the
deployed web app in a WebView. The Xcode project lives in `ios/App/App.xcodeproj`.

- **App name:** Ascension Inventory
- **Bundle ID:** `com.ascensionitai.inventory`  (register this App ID in App Store Connect)
- **Icon + splash:** navy/cyan, already generated into the project.

## Step 1 — Deploy the web app (REQUIRED first)

The app is server-rendered (server actions, API routes, middleware) so it can't be bundled as
static files — the phone loads the live server. Until it's deployed, the app opens to a
"Connecting…" fallback.

1. Deploy the Next.js app to a live HTTPS origin (Netlify — `netlify.toml` is set up).
   - Set these env vars in the Netlify dashboard: `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
     `NEXT_PUBLIC_SITE_URL` = the deployed origin (no trailing slash).
2. Note the deployed URL, e.g. `https://ascension-inventory.netlify.app`.

## Step 2 — Point the iOS app at that URL

From the project root:

```bash
CAP_SERVER_URL="https://YOUR-DEPLOYED-URL" npx cap sync ios
```

(or edit `SERVER_URL` in `capacitor.config.ts`, then `npx cap sync ios`). Confirm
`ios/App/App/capacitor.config.json` now shows your real URL under `server.url`.

## Step 3 — Sign, archive, upload (in Xcode, with your Apple account)

1. `open ios/App/App.xcodeproj`
2. Select the **App** target → **Signing & Capabilities** → check **Automatically manage
   signing** → pick your **Team**. (Bundle ID is already `com.ascensionitai.inventory`; if that
   App ID isn't in your account yet, Xcode will offer to create it, or register it in App Store
   Connect first.)
3. Set the run destination to **Any iOS Device (arm64)**.
4. **Product → Archive.** When the Organizer opens, **Distribute App → App Store Connect →
   Upload.**
5. In App Store Connect, the build appears under **TestFlight** after processing (a few
   minutes). Add yourself as an internal tester → install **TestFlight** on your phone → the app
   downloads there.

## Notes

- **TestFlight vs public App Store:** for the demo, TestFlight is the target and a WebView-backed
  app is fine there. Apple's public App Store review (guideline 4.2) can reject an app that's
  "just a website" — before a full release we'd add native value (push notifications, offline
  cache, camera for scanning, etc.). Push is the natural next one and Capacitor supports it.
- **Re-deploying the web app** does NOT require a new iOS build — the shell always loads the live
  URL, so web changes appear instantly. You only rebuild the iOS app to change the URL, icon,
  bundle ID, or native capabilities.
- To run it in the local simulator while developing: `CAP_SERVER_URL="https://…" npx cap run ios`.
