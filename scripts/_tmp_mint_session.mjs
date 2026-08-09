import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

function loadEnv(name) {
  const env = {}
  for (const line of fs.readFileSync(name, 'utf8').split('\n')) {
    const l = line.trim().replace(/^export /, '')
    if (!l || l.startsWith('#')) continue
    const idx = l.indexOf('=')
    env[l.slice(0, idx)] = l.slice(idx + 1).replace(/^['"]|['"]$/g, '')
  }
  return env
}

const scraper = loadEnv('.env.scraper')
const appEnv = loadEnv('.env')
const url = scraper.SUPABASE_URL
const service = scraper.SUPABASE_SERVICE_KEY
const anon = appEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY

const email = process.argv[2]

const admin = createClient(url, service)
const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
if (error) throw error

const anonClient = createClient(url, anon)
const { data: verified, error: verr } = await anonClient.auth.verifyOtp({
  token_hash: data.properties.hashed_token,
  type: 'email',
})
if (verr) throw verr

console.log(JSON.stringify(verified.session))
