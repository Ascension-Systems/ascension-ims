/**
 * Scheduled trigger for the morning digest. Netlify runs this on the cron below (13:00 UTC =
 * 8am Central); all it does is call our own /api/push/digest with the shared secret — the
 * digest's content and sending live in the Next.js route, where the rest of the push code is.
 *
 * Requires PUSH_CRON_SECRET and NEXT_PUBLIC_SITE_URL in the Netlify environment.
 */
export default async () => {
  const base = process.env.NEXT_PUBLIC_SITE_URL
  const secret = process.env.PUSH_CRON_SECRET
  if (!base || !secret) {
    console.log('[daily-digest] skipped: NEXT_PUBLIC_SITE_URL or PUSH_CRON_SECRET unset')
    return new Response('skipped', { status: 200 })
  }
  const res = await fetch(`${base}/api/push/digest`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  })
  console.log('[daily-digest] digest endpoint returned', res.status)
  return new Response(String(res.status), { status: 200 })
}

export const config = {
  schedule: '0 13 * * *',
}
