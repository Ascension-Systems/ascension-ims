import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the PWA files. The service worker and manifest
     * must be reachable without a session or the app will not install.
     *
     * Middleware is convenience, not access control. The real gate is the database.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon-.*\\.png|apple-touch-icon\\.png|manifest\\.webmanifest|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
