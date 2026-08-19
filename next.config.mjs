import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * SECURITY RESPONSE HEADERS.
 *
 * Added in the security audit pass. The build previously shipped with no security headers at
 * all beyond `poweredByHeader: false`, which is the first thing a pen test reports.
 *
 * Every directive below is chosen to be inert with respect to how this app actually works —
 * none of them can change a rendered page, a redirect, a Server Action or a route handler.
 * Read the notes before adding to this list; two obvious additions are deliberately absent.
 */
const SECURITY_HEADERS = [
  /**
   * The Supabase auth cookie is written by @supabase/ssr with `secure` unset and
   * `httpOnly: false` (its documented defaults, verified in
   * node_modules/@supabase/ssr/dist/main/utils/constants.js). HSTS is what removes the
   * first-request plaintext window in which that cookie could be sent over http://.
   *
   * No `preload`. Preloading is a long-lived, hard-to-reverse commitment on the apex domain
   * and is the operator's call, not a build-time default.
   */
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },

  /** Clickjacking. This app is never framed; it is a standalone-display PWA. */
  { key: 'X-Frame-Options', value: 'DENY' },

  /** MIME-sniffing. */
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  /**
   * Magic-link callbacks carry `code` / `token_hash` in the query string. This app loads no
   * third-party resource of any kind and has no outbound links, so `no-referrer` costs
   * nothing and removes every path by which a single-use auth token could ride a Referer
   * header off-origin.
   */
  { key: 'Referrer-Policy', value: 'no-referrer' },

  /** No page here uses any of these. Denying them costs nothing and shrinks the surface. */
  {
    key: 'Permissions-Policy',
    value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  },

  /** Cross-origin window handle isolation. Nothing here opens or is opened by a popup. */
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },

  /**
   * A private portal for ~120 pre-provisioned reps. There is no public content to index and
   * an indexed login page is free reconnaissance. Reversible in one line if anyone wants the
   * site discoverable.
   */
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },

  /**
   * CSP, RESTRICTED TO THE DIRECTIVES THAT CANNOT BREAK THIS APP.
   *
   * `script-src` and `default-src` are DELIBERATELY ABSENT. app/layout.tsx renders an inline
   * <script> for service-worker registration and Next.js emits its own inline bootstrap, so a
   * `script-src` policy here would need per-request nonces threaded through the middleware —
   * a functional change, not a header fix, and out of scope for a security patch. That work is
   * reported as a recommendation rather than guessed at here.
   *
   * The four directives below are enforceable today with no behavioural risk:
   *   frame-ancestors  clickjacking, and the modern replacement for X-Frame-Options
   *   base-uri         blocks <base> injection retargeting every relative URL on the page
   *   form-action      blocks an injected form from posting the session somewhere else
   *   object-src       no plugin content is used anywhere
   */
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This repo lives inside another checkout that has its own lockfile. Without this, Next
  // infers the wrong workspace root and traces the wrong file set into the deployed
  // function bundle.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
