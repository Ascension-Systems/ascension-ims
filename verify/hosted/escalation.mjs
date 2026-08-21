// Privilege-escalation attacks against the role-aware onboarding (0016) and the role model.
// The question every one of these asks: can someone who should be a rep become an admin?
// Runs against the hosted DB. Requires 0016 applied.
//
//   . ./.env.local && node verify/hosted/escalation.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const svc = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let pass = 0, fail = 0
const ok = (c, label) => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label}`) } }

async function signedClient(email, password) {
  const c = createClient(URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed ${email}: ${error.message}`)
  return { c, uid: data.user.id }
}

const A = 'esc.admin@example.invalid'
const R = 'esc.rep@example.invalid'

async function main() {
  const { data: codes } = await svc.from('enrollment_codes').select('code, role, is_active').eq('is_active', true)
  const repCode = codes?.find((c) => c.role === 'rep')?.code
  const adminCode = codes?.find((c) => c.role === 'admin')?.code
  if (!repCode || !adminCode) throw new Error('need an active rep code and admin code (is 0016 applied + TORTUGA2026 present?)')

  // Fixtures: two throwaway auth users, invited at their respective roles, unclaimed.
  const mk = async (email) => {
    const { data: list } = await svc.auth.admin.listUsers({ perPage: 200 })
    const existing = list.users.find((u) => u.email?.toLowerCase() === email)
    if (existing) return existing.id
    const { data } = await svc.auth.admin.createUser({ email, password: 'REDACTED-USE-ENV-LOCAL', email_confirm: true })
    return data.user.id
  }
  const adminUid = await mk(A)
  const repUid = await mk(R)
  await svc.from('invited_reps').upsert([{ email: A, role: 'admin' }, { email: R, role: 'rep' }], { onConflict: 'email' })
  await svc.from('invited_reps').update({ claimed_by: null, claimed_at: null }).in('email', [A, R])
  await svc.from('profiles').delete().in('id', [adminUid, repUid]) // start clean

  const claim = (code, email, uid) => svc.rpc('claim_enrollment', { p_code: code, p_email: email, p_user_id: uid })
  const roleOf = async (uid) => (await svc.from('profiles').select('role').eq('id', uid).maybeSingle()).data?.role ?? null

  console.log('\nCode/role match — the admin code cannot mint an admin on its own:')
  {
    const r1 = await claim(adminCode, R, repUid)
    ok(!!r1.error && (await roleOf(repUid)) === null, 'admin code + a REP-invited address -> REFUSED (no profile)')
    const r2 = await claim(repCode, A, adminUid)
    ok(!!r2.error && (await roleOf(adminUid)) === null, 'rep code + an ADMIN-invited address -> REFUSED')
    const r3 = await claim(adminCode, 'esc.ghost@example.invalid', adminUid)
    ok(!!r3.error, 'admin code + a NON-invited address -> REFUSED')
  }

  console.log('\nThe only paths that work are the intended ones:')
  {
    const r4 = await claim(adminCode, A, adminUid)
    ok(!r4.error && (await roleOf(adminUid)) === 'admin', 'admin invite + admin code -> provisioned ADMIN')
    const r5 = await claim(repCode, R, repUid)
    ok(!r5.error && (await roleOf(repUid)) === 'rep', 'rep invite + rep code -> provisioned REP')
  }

  console.log('\nA real REP cannot escalate through the database directly:')
  {
    const { c: rep, uid: repRealUid } = await signedClient('calebjawo@gmail.com', 'REDACTED-USE-ENV-LOCAL')
    const selfElevate = await rep.from('profiles').update({ role: 'admin' }).eq('id', repRealUid).select('role')
    const stillRep = (await roleOf(repRealUid)) === 'rep'
    ok(((selfElevate.data ?? []).length === 0 || !!selfElevate.error) && stillRep, 'rep CANNOT set their own profile role to admin')

    const mkCode = await rep.from('enrollment_codes').insert({ code: 'REP-PWNADMIN', label: 'x', role: 'admin' }).select('code')
    ok((mkCode.data ?? []).length === 0 || !!mkCode.error, 'rep CANNOT create an enrollment code (admin or otherwise)')

    const selfInvite = await rep.from('invited_reps').insert({ email: 'hacker@evil.invalid', role: 'admin' }).select('email')
    ok((selfInvite.data ?? []).length === 0 || !!selfInvite.error, 'rep CANNOT add themselves/anyone to the allowlist as admin')

    const readRoster = await rep.from('invited_reps').select('email').limit(1)
    ok((readRoster.data ?? []).length === 0, 'rep CANNOT read the allowlist roster')
    const readCodes = await rep.from('enrollment_codes').select('code').limit(1)
    ok((readCodes.data ?? []).length === 0, 'rep CANNOT read enrollment codes')
  }

  // Cleanup: remove fixtures, undo the two successful claims' usage bumps.
  await svc.from('profiles').delete().in('id', [adminUid, repUid])
  await svc.auth.admin.deleteUser(adminUid).catch(() => {})
  await svc.auth.admin.deleteUser(repUid).catch(() => {})
  await svc.from('invited_reps').delete().in('email', [A, R])
  for (const c of [adminCode, repCode]) {
    const { data } = await svc.from('enrollment_codes').select('uses').eq('code', c).maybeSingle()
    if (data && data.uses > 0) await svc.from('enrollment_codes').update({ uses: data.uses - 1 }).eq('code', c)
  }

  console.log(`\nEscalation attacks: ${pass} passed, ${fail} failed, of ${pass + fail}.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
