// Live-fire adversarial verification of the document hub, against the hosted DB.
// Proves the audit fixes hold at the DATABASE, not just in app code — especially the HIGH
// finding: a rep must not reach hidden / scheduled / expired documents or their files, even
// when calling PostgREST and storage directly with the public anon key + their own JWT.
//
// Self-contained: creates its own fixtures via the service role, signs in as a real rep and a
// real admin, attacks as each (and as anon), asserts, then cleans up. Requires 0015 applied.
//
//   . ./.env.local && node verify/hosted/documents.mjs
//
// Needs two accounts with known passwords, supplied via .env.local (which is gitignored):
//   VERIFY_REP_EMAIL / VERIFY_REP_PASSWORD
//   VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD
// These were once literals in this file. They are real account passwords, so they belong in the
// dotenv file with every other credential, not in tracked source.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

/** Credentials must come from .env.local. Fail loudly rather than half-running with undefined. */
function requireEnv(name) {
  const v = env[name]
  if (!v) {
    console.error(`Missing ${name} in .env.local — see .env.example for the required names.`)
    process.exit(1)
  }
  return v
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC = env.SUPABASE_SERVICE_ROLE_KEY

const svc = createClient(URL, SVC, { auth: { persistSession: false } })

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}`)
  }
}

async function signedClient(email, password) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return c
}

const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'latin1')

async function main() {
  await svc.storage.createBucket('documents', { public: false }).catch(() => {})

  const now = Date.now()
  const future = new Date(now + 7 * 864e5).toISOString()
  const past = new Date(now - 7 * 864e5).toISOString()
  const uid = () => globalThis.crypto.randomUUID()

  // Fixtures: one of each visibility class, each with a real stored object.
  const fx = {
    visible: { kind: 'promotion', title: 'VERIFY visible', active: true, storage_path: `promotion/${uid()}.pdf` },
    hidden: { kind: 'promotion', title: 'VERIFY hidden', active: false, storage_path: `promotion/${uid()}.pdf` },
    scheduled: { kind: 'promotion', title: 'VERIFY scheduled', active: true, starts_at: future, storage_path: `promotion/${uid()}.pdf` },
    expired: { kind: 'promotion', title: 'VERIFY expired', active: true, ends_at: past, storage_path: `promotion/${uid()}.pdf` },
  }
  const created = []
  for (const [k, f] of Object.entries(fx)) {
    await svc.storage.from('documents').upload(f.storage_path, PDF, { contentType: 'application/pdf' })
    const ins = await svc
      .from('documents')
      .insert({ ...f, mime_type: 'application/pdf', size_bytes: PDF.length })
      .select('id')
      .single()
    if (ins.error) throw new Error(`fixture ${k} insert failed (is 0015 applied?): ${ins.error.message}`)
    fx[k].id = ins.data.id
    created.push({ id: ins.data.id, path: f.storage_path })
  }

  try {
    const rep = await signedClient(requireEnv('VERIFY_REP_EMAIL'), requireEnv('VERIFY_REP_PASSWORD'))
    const admin = await signedClient(requireEnv('VERIFY_ADMIN_EMAIL'), requireEnv('VERIFY_ADMIN_PASSWORD'))
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })

    console.log('\nFinding 1 — a REP must not reach hidden / scheduled / expired rows or files:')
    {
      const { data } = await rep.from('documents').select('id,title').ilike('title', 'VERIFY %')
      const titles = new Set((data ?? []).map((r) => r.title))
      ok(titles.has('VERIFY visible'), 'rep CAN read the visible row')
      ok(!titles.has('VERIFY hidden'), 'rep CANNOT read the hidden row (active=false)')
      ok(!titles.has('VERIFY scheduled'), 'rep CANNOT read the scheduled row (future starts_at)')
      ok(!titles.has('VERIFY expired'), 'rep CANNOT read the expired row (past ends_at)')
    }
    {
      const vis = await rep.storage.from('documents').createSignedUrl(fx.visible.storage_path, 60)
      ok(!!vis.data?.signedUrl && !vis.error, 'rep CAN sign the visible object')
      for (const k of ['hidden', 'scheduled', 'expired']) {
        const r = await rep.storage.from('documents').createSignedUrl(fx[k].storage_path, 60)
        ok(!r.data?.signedUrl, `rep CANNOT sign the ${k} object (direct storage API)`)
      }
    }

    console.log('\nWrite protection — a REP cannot modify the catalogue or bucket:')
    {
      const insDenied = await rep
        .from('documents')
        .insert({ kind: 'flyer', title: 'REP INJECT', storage_path: `flyer/${uid()}.pdf`, mime_type: 'application/pdf', size_bytes: 1 })
        .select('id')
      ok(!!insDenied.error || (insDenied.data ?? []).length === 0, 'rep CANNOT insert a document row')
      const delDenied = await rep.from('documents').delete().eq('id', fx.visible.id).select('id')
      ok((delDenied.data ?? []).length === 0, 'rep CANNOT delete a document row')
      const updDenied = await rep.from('documents').update({ active: false }).eq('id', fx.visible.id).select('id')
      ok((updDenied.data ?? []).length === 0, 'rep CANNOT update a document row')
      const upDenied = await rep.storage.from('documents').upload(`promotion/${uid()}.pdf`, PDF, { contentType: 'application/pdf' })
      ok(!!upDenied.error, 'rep CANNOT upload to the bucket')
    }

    console.log('\nAnonymous — no session sees nothing:')
    {
      const { data } = await anon.from('documents').select('id').ilike('title', 'VERIFY %')
      ok((data ?? []).length === 0, 'anon reads zero document rows')
      const r = await anon.storage.from('documents').createSignedUrl(fx.visible.storage_path, 60)
      ok(!r.data?.signedUrl, 'anon CANNOT sign even a visible object')
    }

    console.log('\nAdmin — full visibility (the management view):')
    {
      const { data } = await admin.from('documents').select('title').ilike('title', 'VERIFY %')
      const titles = new Set((data ?? []).map((r) => r.title))
      ok(titles.has('VERIFY hidden') && titles.has('VERIFY scheduled') && titles.has('VERIFY expired'), 'admin CAN read hidden/scheduled/expired rows')
      const r = await admin.storage.from('documents').createSignedUrl(fx.hidden.storage_path, 60)
      ok(!!r.data?.signedUrl, 'admin CAN sign a hidden object')
    }
  } finally {
    // Clean up fixtures no matter what.
    await svc.storage.from('documents').remove(created.map((c) => c.path)).catch(() => {})
    await svc.from('documents').delete().in('id', created.map((c) => c.id))
  }

  console.log(`\nDocument hub live-fire: ${pass} passed, ${fail} failed, of ${pass + fail}.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
