import fs from 'node:fs'; import { createClient } from '@supabase/supabase-js'
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}))
const svc=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const stage=process.argv[2]
const FAKE='cafebabe'.repeat(8) // 64 hex, valid format, but not a real Apple device
if(stage==='insert'){
  const { data: admin } = await svc.from('profiles').select('id,email').eq('role','admin').limit(1).maybeSingle()
  await svc.from('push_tokens').upsert({token:FAKE,user_id:admin.id,platform:'ios'})
  console.log('inserted fake token for admin', admin.email)
}
if(stage==='check'){
  const { data } = await svc.from('push_tokens').select('token').eq('token',FAKE)
  if(!data || data.length===0) console.log('RESULT: fake token was PRUNED -> Apple was reached + authenticated + rejected the bad token. Full APNs auth chain WORKS.')
  else { console.log('RESULT: fake token STILL PRESENT -> send did not reach Apple / auth failed. Investigating needed.'); await svc.from('push_tokens').delete().eq('token',FAKE) }
}
