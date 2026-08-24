import { NextResponse } from 'next/server'
import { diagnoseApns } from '@/lib/push'

/**
 * TEMPORARY APNs diagnostic. Cron-secret gated (no session), same as the digest. Reports where
 * the APNs chain stands so a delivery failure can be pinpointed without a real device. REMOVE
 * once push is confirmed working.
 */
export async function POST(request: Request) {
  const secret = process.env.PUSH_CRON_SECRET
  if (!secret || request.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }
  return NextResponse.json(await diagnoseApns())
}
