// Load test: can the stack take ~120 reps recording commitments?
// Creates throwaway reps, drives CONCURRENT record_commitment calls, measures throughput and
// latency, and — critically — proves the oversell guarantee still holds under contention.
// All fixtures are cleaned up. Runs against the hosted DB.
//
//   . ./.env.local && node verify/hosted/loadtest.mjs
//
// Honest framing: 120 reps in the field commit a few times per session — peak CONCURRENCY is a
// handful, not 120. This test sustains N truly-concurrent writers (heavier than that peak) so the
// throughput/headroom it reports is a conservative floor.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const svc = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const N_REPS = 20          // concurrent writers
const SPREAD_CALLS = 15    // low-contention commits per rep (random hot-stock SKUs)
const PW = 'LoadTest-9137!'
const emailFor = (i) => `load.rep.${i}@example.invalid`

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }

async function main() {
  console.log(`\nLoad test — ${N_REPS} concurrent reps against ${URL}\n`)

  // Availability per SKU (compute from components; view field names vary).
  const { data: inv } = await svc.from('v_inventory').select('*')
  const avail = (r) => (r.available ?? (r.qty_on_hand - (r.qty_committed_source ?? 0) - (r.qty_committed_portal ?? 0)))
  const pool = inv.map((r) => ({ sku: r.sku, available: avail(r) })).filter((r) => r.available > 5)
  pool.sort((a, b) => b.available - a.available)
  const hot = pool.slice(0, 40).map((r) => r.sku)                 // plenty of headroom → commits succeed
  const contended = pool.find((r) => r.available >= 8 && r.available <= 25) || pool[pool.length - 1]
  console.log(`pool: ${pool.length} SKUs with availability > 5; contended SKU ${contended.sku} avail=${contended.available}`)

  // Fixtures: N throwaway reps (auth user + provisioned profile), signed in.
  console.log(`provisioning ${N_REPS} reps…`)
  const reps = []
  for (let i = 0; i < N_REPS; i++) {
    const email = emailFor(i)
    const { data: list } = await svc.auth.admin.listUsers({ perPage: 200 })
    const ex = list.users.find((u) => u.email?.toLowerCase() === email)
    if (ex) await svc.auth.admin.deleteUser(ex.id)
    const { data: c } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true })
    await svc.from('profiles').upsert({ id: c.user.id, email, role: 'rep' }, { onConflict: 'id' })
    const client = createClient(URL, ANON, { auth: { persistSession: false } })
    await client.auth.signInWithPassword({ email, password: PW })
    reps.push({ id: c.user.id, client })
  }

  const commit = async (client, sku) => {
    const t0 = Date.now()
    const { error } = await client.rpc('record_commitment', { p_sku: sku, p_qty: 1, p_location: 'default', p_note: 'loadtest' })
    return { ms: Date.now() - t0, error }
  }

  // PHASE 1 — throughput under concurrency (spread across hot SKUs; expected to succeed).
  console.log(`\nPhase 1 — throughput: ${N_REPS} reps × ${SPREAD_CALLS} commits each…`)
  const lat = []; let ok = 0, rejected = 0, errored = 0
  const start = Date.now()
  await Promise.all(reps.map(async (rep, ri) => {
    for (let k = 0; k < SPREAD_CALLS; k++) {
      const sku = hot[(ri * 7 + k * 13) % hot.length]
      const r = await commit(rep.client, sku)
      lat.push(r.ms)
      if (!r.error) ok++
      else if (r.error.message?.includes('KY001') || /availability/i.test(r.error.message || '')) rejected++
      else { errored++; if (errored <= 3) console.log('  unexpected error:', r.error.code, r.error.message) }
    }
  }))
  const secs = (Date.now() - start) / 1000
  const total = N_REPS * SPREAD_CALLS
  console.log(`  ${total} commits in ${secs.toFixed(1)}s → ${(total / secs).toFixed(0)}/sec`)
  console.log(`  succeeded ${ok} · availability-rejected ${rejected} · REAL errors ${errored}`)
  console.log(`  latency p50 ${pct(lat, 0.5)}ms · p95 ${pct(lat, 0.95)}ms · max ${Math.max(...lat)}ms`)

  // PHASE 2 — contention + oversell integrity: all reps hammer ONE SKU past its availability.
  console.log(`\nPhase 2 — oversell integrity on ${contended.sku} (avail ${contended.available})…`)
  const before = contended.available
  const attempts = before + N_REPS * 3   // guarantee we try to overshoot
  let cOk = 0, cRej = 0, cErr = 0
  await Promise.all(reps.map(async (rep) => {
    for (let k = 0; k < Math.ceil(attempts / N_REPS); k++) {
      const r = await commit(rep.client, contended.sku)
      if (!r.error) cOk++
      else if (r.error.message?.includes('KY001') || /availability/i.test(r.error.message || '')) cRej++
      else cErr++
    }
  }))
  const { data: after } = await svc.from('v_inventory').select('*').eq('sku', contended.sku).single()
  const availAfter = after.available ?? (after.qty_on_hand - (after.qty_committed_source ?? 0) - (after.qty_committed_portal ?? 0))
  console.log(`  succeeded ${cOk} (avail was ${before}) · rejected ${cRej} · errors ${cErr}`)
  console.log(`  availability after: ${availAfter}  ${availAfter >= 0 ? '✓ never negative' : '✗ OVERSOLD'}`)
  const oversellHeld = availAfter >= 0 && cOk <= before && cErr === 0

  // Cleanup: remove all throwaway commitments and reps.
  console.log(`\ncleaning up…`)
  for (const rep of reps) {
    await svc.from('commitments').delete().eq('rep_id', rep.id)
    await svc.auth.admin.deleteUser(rep.id).catch(() => {})
  }

  const pass = errored === 0 && oversellHeld
  console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} — ${errored === 0 ? 'no errors under load' : `${errored} errors`}; oversell ${oversellHeld ? 'held' : 'BROKE'}.`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
