// Load test: can the stack take ~120 reps reading inventory?
// Creates throwaway reps, drives CONCURRENT reads of v_inventory (the page a rep opens), measures
// throughput and latency, and checks every read returned the full catalogue with
// qty_available = qty_on_hand - qty_committed. All fixtures are cleaned up. Runs against the
// hosted DB.
//
//   . ./.env.local && node verify/hosted/loadtest.mjs
//
// Since 0025 reps write nothing to inventory (committed comes from QuickBooks), so the rep
// workload is read-only; the old write-contention phase went with record_commitment. Honest
// framing: 120 reps in the field open the inventory a few times per session — peak CONCURRENCY
// is a handful, not 120. N truly-concurrent readers is heavier than that peak, so the
// throughput/headroom reported is a conservative floor.
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

const N_REPS = 20          // concurrent readers
const READS_PER_REP = 15   // full inventory reads per rep
const PW = 'LoadTest-9137!'
const emailFor = (i) => `load.rep.${i}@example.invalid`

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }

async function main() {
  console.log(`\nLoad test — ${N_REPS} concurrent reps against ${URL}\n`)

  const { count: expected } = await svc.from('inventory').select('sku', { count: 'exact', head: true })
  console.log(`catalogue: ${expected} inventory rows`)

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

  const read = async (client) => {
    const t0 = Date.now()
    const { data, error } = await client.from('v_inventory').select('*').order('name')
    return { ms: Date.now() - t0, data, error }
  }

  console.log(`\nThroughput: ${N_REPS} reps × ${READS_PER_REP} full inventory reads each…`)
  const lat = []; let ok = 0, short = 0, inconsistent = 0, errored = 0
  const start = Date.now()
  await Promise.all(reps.map(async (rep) => {
    for (let k = 0; k < READS_PER_REP; k++) {
      const r = await read(rep.client)
      lat.push(r.ms)
      if (r.error) { errored++; if (errored <= 3) console.log('  unexpected error:', r.error.code, r.error.message); continue }
      if (r.data.length !== expected) { short++; continue }
      if (r.data.some((row) => row.qty_available !== row.qty_on_hand - row.qty_committed)) { inconsistent++; continue }
      ok++
    }
  }))
  const secs = (Date.now() - start) / 1000
  const total = N_REPS * READS_PER_REP
  console.log(`  ${total} reads in ${secs.toFixed(1)}s → ${(total / secs).toFixed(0)}/sec`)
  console.log(`  complete ${ok} · short ${short} · inconsistent ${inconsistent} · errors ${errored}`)
  console.log(`  latency p50 ${pct(lat, 0.5)}ms · p95 ${pct(lat, 0.95)}ms · max ${Math.max(...lat)}ms`)

  console.log(`\ncleaning up…`)
  for (const rep of reps) {
    await svc.auth.admin.deleteUser(rep.id).catch(() => {})
  }

  const pass = errored === 0 && short === 0 && inconsistent === 0
  console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} — ${errored} errors, ${short} short reads, ${inconsistent} inconsistent reads.`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
