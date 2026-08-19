/**
 * Environment access, in one place, read lazily.
 *
 * Lazily on purpose: `next build` must succeed without any Supabase values present. These
 * throw at request time with a message that says which variable is missing, rather than
 * failing the build with a stack trace from inside a vendor module.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately NOT read here. It is read in exactly one file,
 * lib/supabase/admin.ts, which starts with `import 'server-only'`.
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
