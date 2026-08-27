/**
 * Capture real screenshots of the deployed, AUTHENTICATED build via Chrome DevTools Protocol.
 * Node 24 has a global WebSocket, so this needs no dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const ENVFILE='/Users/calebjaworski/kyrie-pipeline/projects/ascension-portal/.env.local'
const env=Object.fromEntries(readFileSync(ENVFILE,'utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}))
const HOST='ascension-inventory.netlify.app'
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT=9333

const who = process.argv[2]==='rep' ? {e:env.VERIFY_REP_EMAIL,p:env.VERIFY_REP_PASSWORD} : {e:env.VERIFY_ADMIN_EMAIL,p:env.VERIFY_ADMIN_PASSWORD}

// 1. real session
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false}})
const {data:si,error}=await sb.auth.signInWithPassword({email:who.e,password:who.p})
if(error) throw new Error('signin: '+error.message)
const ref=env.NEXT_PUBLIC_SUPABASE_URL.split('//')[1].split('.')[0]
const cookieValue='base64-'+Buffer.from(JSON.stringify({
  access_token:si.session.access_token, token_type:'bearer', expires_at:si.session.expires_at,
  expires_in:si.session.expires_in, refresh_token:si.session.refresh_token, user:si.user,
})).toString('base64')

// 2. chrome
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,'--headless=new','--disable-gpu',
  '--hide-scrollbars','--force-device-scale-factor=2','--user-data-dir=/tmp/shots/profile','about:blank'],{stdio:'ignore'})
await new Promise(r=>setTimeout(r,3000))

const targets=await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page=targets.find(t=>t.type==='page')
const ws=new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r=>ws.addEventListener('open',r))
let id=0; const pending=new Map()
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m); pending.delete(m.id)}})
const send=(method,params={})=>new Promise(res=>{const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method,params}))})

await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable')
await send('Network.setCookie',{name:`sb-${ref}-auth-token`,value:cookieValue,domain:HOST,path:'/',secure:true})

const SHOTS=JSON.parse(process.env.SHOTS)
for(const s of SHOTS){
  await send('Emulation.setDeviceMetricsOverride',{width:s.w,height:s.h,deviceScaleFactor:2,mobile:!!s.mobile})
  await send('Page.navigate',{url:`https://${HOST}${s.path}`})
  await new Promise(r=>setTimeout(r, s.wait ?? 6000))
  if(s.js) await Promise.race([send('Runtime.evaluate',{expression:s.js}), new Promise(r=>setTimeout(r,4000))])
  if(s.after) await new Promise(r=>setTimeout(r,s.after))
  const shot=await Promise.race([send('Page.captureScreenshot',{format:'png'}), new Promise(r=>setTimeout(()=>r(null),20000))])
  if(!shot){console.log('TIMEOUT',s.name);continue}
  const {result}=shot
  writeFileSync(`/tmp/shots/${s.name}.png`, Buffer.from(result.data,'base64'))
  console.log('captured', s.name, s.path, `${s.w}x${s.h}`)
}
ws.close(); chrome.kill()
