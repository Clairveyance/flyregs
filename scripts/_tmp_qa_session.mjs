// QA helper: mint a browser session for a @flyregs.invalid TEST account so a
// tier sweep can run as a genuinely Free/Plus/Pro user, not just a client-side
// tier override. Deleted after the sweep.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
const env = (f) => Object.fromEntries(fs.readFileSync(f,'utf8').split('\n')
  .map(l=>l.trim().replace(/^export\s+/,''))
  .filter(l=>l&&!l.startsWith('#'))
  .map(l=>{const i=l.indexOf('=');return [l.slice(0,i), l.slice(i+1).replace(/^["']|["']$/g,'')]}))
const e1 = env('.env.scraper'), e2 = env('.env')
const url = e2.EXPO_PUBLIC_SUPABASE_URL
const email = process.argv[2]
if (!email.endsWith('@flyregs.invalid')) { console.error('test accounts only'); process.exit(1) }
const admin = createClient(url, e1.SUPABASE_SERVICE_KEY, {auth:{persistSession:false}})
const anon  = createClient(url, e2.EXPO_PUBLIC_SUPABASE_ANON_KEY, {auth:{persistSession:false}})
const { data, error } = await admin.auth.admin.generateLink({ type:'magiclink', email })
if (error) { console.error('generateLink', error.message); process.exit(1) }
const { data: s, error: e3 } = await anon.auth.verifyOtp({ token_hash: data.properties.hashed_token, type:'email' })
if (e3) { console.error('verifyOtp', e3.message); process.exit(1) }
const ref = url.replace(/^https?:\/\//,'').split('.')[0]
console.log(JSON.stringify({ key:`sb-${ref}-auth-token`, session:s.session }))
