/**
 * Environment access, in one place, read lazily.
 *
 * Lazily on purpose: `next build` must succeed without any Supabase values present. These
 * throw at request time with a message that says which variable is missing, rather than
 * failing the build with a stack trace from inside a vendor module.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately NOT read here. It is read in exactly one file,
 * lib/supabase/admin.ts, which starts with `import 'server-only'`.
 *
 * ------------------------------------------------------------------------------------
 * NEXT_PUBLIC_SITE_URL EXISTS SO THE MAGIC-LINK REDIRECT ORIGIN COMES FROM TRUSTED
 * CONFIGURATION, NEVER FROM A REQUEST HEADER.
 * ------------------------------------------------------------------------------------
 * `app/login/actions.ts` used to build `emailRedirectTo` out of `x-forwarded-host` / `host`,
 * and `app/auth/callback/route.ts` used to build its redirects out of `request.nextUrl`, which
 * is derived from the same header. Both are attacker-settable. A login request submitted for a
 * VICTIM'S address with a forged host header would send that victim a magic link pointing at
 * the attacker's origin; clicking it hands the attacker the auth `code`, which is account
 * takeover.
 *
 * Removing this variable and falling back to `x-forwarded-host` re-creates that path exactly.
 * Do not do it "for preview deployments" — a preview deployment sets its own
 * NEXT_PUBLIC_SITE_URL, which is the supported way.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in ` +
        `from the Supabase dashboard (Project Settings -> API), or set it in the Netlify ` +
        `dashboard for a deployed build.`,
    )
  }
  return value
}

export function supabaseUrl(): string {
  return required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
}

export function supabaseAnonKey(): string {
  return required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

/**
 * The origin this application puts in magic-link emails and in its own auth redirects.
 *
 * Returns `url.origin` — protocol + host, normalised, no trailing slash — so every call site
 * can safely write `${siteUrl()}/auth/callback`.
 *
 * Validation is exhaustive and lives here because this is the established single point of
 * environment access. A value that is present but wrong is more dangerous than one that is
 * missing: a path, a query string or a bare hostname all produce a link that either 404s or
 * silently goes somewhere unintended.
 *
 * Not memoised, deliberately: `supabaseUrl()` and `supabaseAnonKey()` are lazy so that
 * `next build` succeeds with nothing configured, and the parse below is trivial.
 *
 * ECHOING THE REJECTED VALUE IS DELIBERATE AND PERMITTED HERE. An origin is definitionally
 * public — it appears in every email this app sends — and a validator that refuses to say what
 * it rejected is hostile to the operator trying to fix it. This is the ONLY environment value
 * in this codebase that may be echoed. Do not copy the pattern to the two above.
 */
export function siteUrl(): string {
  const raw = required('NEXT_PUBLIC_SITE_URL', process.env.NEXT_PUBLIC_SITE_URL)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL is not an absolute URL: ${raw}. Expected an origin such as ` +
        `https://portal.example.com`,
    )
  }

  // https only, with a local-development exception. Without the exception the README's own
  // http://127.0.0.1:3000 instructions would fail.
  const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost)) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must use https, except http:// on localhost or 127.0.0.1. ` +
        `Got: ${raw}`,
    )
  }

  // An origin, not a URL with a path. A path would produce https://host/foo/auth/callback.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be a bare origin with no path, query string or fragment. ` +
        `Got: ${raw}`,
    )
  }

  return url.origin
}
