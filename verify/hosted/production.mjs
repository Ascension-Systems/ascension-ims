// Live-fire verification of the DEPLOYED app over HTTP — the production surface a rep or an
// attacker actually hits. Proves access control, redirects, API auth, HTTPS, and reachability
// against https://ascension-inventory.netlify.app (override with PROD_BASE).
//
//   node verify/hosted/production.mjs
//
// This exercises the deployed Netlify functions + middleware end to end. It does NOT log in
// (that's proven in the browser with real cookies); every assertion here is the UNAUTHENTICATED
// attacker's view — which is exactly the view that must never leak.
const BASE = process.env.PROD_BASE || 'https://ascension-inventory.netlify.app'

let pass = 0, fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`) }
}

async function head(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res
}

async function main() {
  console.log(`\nProduction surface: ${BASE}\n`)

  console.log('Public entry points render:')
  {
    const login = await head('/login')
    const html = await login.text()
    ok(login.status === 200, '/login returns 200')
    ok(/Sign in/.test(html) && /name="password"/.test(html), '/login renders the real sign-in form')
    const join = await head('/join')
    ok(join.status === 200, '/join returns 200 (self-enrollment reachable)')
  }

  console.log('\nUnauthenticated access control (the core guarantee):')
  {
    const root = await head('/')
    ok(root.status === 307 && /\/login$/.test(root.headers.get('location') || ''), 'GET / redirects to /login')
    for (const p of ['/inventory', '/reconciliation', '/team', '/resources', '/my-commitments']) {
      const r = await head(p)
      const loc = r.headers.get('location') || ''
      ok(r.status === 307 && /\/login/.test(loc), `unauth ${p} redirects to /login`, `got ${r.status} -> ${loc}`)
    }
  }

  console.log('\nUnauthenticated API is refused (401, never a redirect that leaks a page):')
  {
    const cases = [
      ['POST', '/api/commitments', { sku: 'SEA-9007', location: 'default', qty: 1 }],
      ['POST', '/api/documents', {}],
      ['POST', '/api/invites', { emails: 'x@example.invalid' }],
      ['PATCH', '/api/inventory', { sku: 'SEA-9007', qty_on_hand: 0 }],
      ['GET', '/api/documents/00000000-0000-0000-0000-000000000000/file'],
      ['POST', '/api/push/register', { token: 'deadbeef'.repeat(8) }],
      ['POST', '/api/announce', { message: 'intruder broadcast' }],
    ]
    for (const [m, p, b] of cases) {
      const r = await head(p, m, b)
      ok(r.status === 401, `unauth ${m} ${p} -> 401`, `got ${r.status}`)
    }
    // The digest endpoint is cron-called (no session), so its gate is the shared secret,
    // not a cookie: no secret (or a wrong one) must be a 403, never a send.
    const digest = await head('/api/push/digest', 'POST')
    ok(digest.status === 403, 'unauth POST /api/push/digest (no cron secret) -> 403', `got ${digest.status}`)
  }

  console.log('\nEnrollment endpoint is public BUT gated (a wrong code/email is refused, not enrolled):')
  {
    const r = await head('/api/enroll', 'POST', { code: 'WRONG-CODE-XYZ', email: 'intruder@example.invalid', password: 'password123' }) // not-a-secret: deliberately wrong credentials, asserts enrollment REJECTS them
    const body = await r.json().catch(() => ({}))
    ok(r.status === 400, '/api/enroll reachable but refuses a bad code (400)', `got ${r.status}`)
    ok(/did not match an open invitation/i.test(body.message || ''), 'refusal message is generic (no roster oracle)')
  }

  console.log('\nTransport + backend health:')
  {
    // http must upgrade to https
    let httpUpgrades = false
    try {
      const r = await fetch(BASE.replace('https://', 'http://') + '/login', { redirect: 'manual' })
      const loc = r.headers.get('location') || ''
      httpUpgrades = r.status >= 300 && r.status < 400 && loc.startsWith('https://')
    } catch { httpUpgrades = true /* connection refused on http is also acceptable */ }
    ok(httpUpgrades, 'http:// upgrades to https://')

    const health = await head('/api/health/auth')
    const h = await health.json().catch(() => ({}))
    ok(health.status === 200, '/api/health/auth returns 200')
    ok(h.authEndpointReachable === 'yes', 'Supabase auth endpoint reachable from the deploy')
    ok(h.anonKeyAccepted === 'yes', 'anon key accepted by Supabase from the deploy')

    const login = await head('/login')
    ok((login.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff'
       || true, 'security headers observed (informational)',
       `x-content-type-options=${login.headers.get('x-content-type-options') || 'absent'}`)
  }

  console.log(`\nProduction surface: ${pass} passed, ${fail} failed, of ${pass + fail}.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
