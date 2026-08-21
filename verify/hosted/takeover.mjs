// Regression test for the CRITICAL /api/enroll account-takeover.
// Runs the exact attack against the DEPLOYED app and proves a victim's password is NOT changed
// by an unauthorised enroll. Requires the app deployed (PROD_BASE) and 0016 applied.
//
//   . ./.env.local && node verify/hosted/takeover.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const BASE = process.env.PROD_BASE || 'https://ascension-inventory.netlify.app'
const svc = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let pass = 0, fail = 0
const ok = (c, label) => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label}`) } }

const VICTIM = 'takeover.victim@example.invalid'
const ORIGINAL = 'Original-Password-9137!'
const ATTACKER = 'ATTACKER-OWNED-0000!'

async function canLogin(email, password) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  return !error && !!data.session
}

async function attack(code) {
  const res = await fetch(`${BASE}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, email: VICTIM, password: ATTACKER }),
  })
  return res.status
}

async function main() {
  const { data: codes } = await svc.from('enrollment_codes').select('code, role, is_active').eq('is_active', true)
  const repCode = codes?.find((c) => c.role === 'rep')?.code ?? 'ASCENSION-2026'

  // Fresh victim with a known password. NOT on the allowlist — like info@, a real account an
  // attacker would target by email alone.
  const { data: list } = await svc.auth.admin.listUsers({ perPage: 200 })
  const existing = list.users.find((u) => u.email?.toLowerCase() === VICTIM)
  if (existing) await svc.auth.admin.deleteUser(existing.id)
  await svc.auth.admin.createUser({ email: VICTIM, password: ORIGINAL, email_confirm: true })

  ok(await canLogin(VICTIM, ORIGINAL), 'victim can log in with its ORIGINAL password (baseline)')

  console.log('\nAttack 1 — bogus code + victim email + attacker password:')
  {
    const status = await attack('BOGUS-CODE-DOESNOTEXIST')
    ok(status === 400, 'enroll REFUSED (400)')
    ok(await canLogin(VICTIM, ORIGINAL), "victim's ORIGINAL password STILL works (not overwritten)")
    ok(!(await canLogin(VICTIM, ATTACKER)), "attacker's password is REJECTED (takeover failed)")
  }

  console.log('\nAttack 2 — a VALID rep code, but victim is not on the allowlist:')
  {
    const status = await attack(repCode)
    ok(status === 400, 'enroll REFUSED (400)')
    ok(await canLogin(VICTIM, ORIGINAL), "victim's ORIGINAL password STILL works")
    ok(!(await canLogin(VICTIM, ATTACKER)), "attacker's password is REJECTED")
  }

  // Cleanup
  const { data: after } = await svc.auth.admin.listUsers({ perPage: 200 })
  const v = after.users.find((u) => u.email?.toLowerCase() === VICTIM)
  if (v) await svc.auth.admin.deleteUser(v.id)

  console.log(`\nTakeover regression: ${pass} passed, ${fail} failed, of ${pass + fail}.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
