// Sends the daily "Reg of the Day" push notification (Pro/Premium, opt-in
// toggle separate from AC Update Alerts) -- a rotating P/CG term, same
// "word of the day" idea as a dictionary app. Meant to run once per day via
// its own scheduled workflow, NOT as part of the weekly content-sync
// pipeline (sync.sh) -- this has nothing to do with content changing, it
// fires every day regardless of whether anything was scraped that week.
//
// Run from the ac-app/ directory:
//   node scripts/send-reg-of-day.mjs
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper (bypasses
// RLS, needed to read every opted-in push_tokens row across all users).

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
if (!fs.existsSync(envPath)) {
  console.error('Missing .env.scraper (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)')
  process.exit(1)
}
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_KEY not found in .env.scraper')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const { data: regOfDay, error: rodErr } = await sb.rpc('get_reg_of_the_day')
if (rodErr) {
  console.error('get_reg_of_the_day RPC failed:', rodErr.message)
  process.exit(1)
}
const today = regOfDay?.[0]
if (!today) {
  console.error('get_reg_of_the_day returned no row -- pcg_terms empty?')
  process.exit(1)
}

const { data: tokens, error: tokenErr } = await sb
  .from('push_tokens')
  .select('expo_push_token')
  .eq('enabled', true)
  .eq('reg_of_day_enabled', true)

if (tokenErr) {
  console.error('Failed to fetch push tokens:', tokenErr.message)
  process.exit(1)
}
if (!tokens || tokens.length === 0) {
  console.log('No devices opted into Reg of the Day -- nothing to send.')
  process.exit(0)
}

console.log(`Sending "${today.term}" to ${tokens.length} device(s).`)

// Truncated to a single readable line -- this is a lock-screen notification
// body, not the full glossary entry; tapping it opens the real definition
// in-app (see data.pcgSlug, read by the app's notification-response handler).
const bodyText = today.definition.length > 120 ? `${today.definition.slice(0, 117)}...` : today.definition

const messages = tokens.map((t) => ({
  to: t.expo_push_token,
  sound: 'default',
  title: `Reg of the Day: ${today.term}`,
  body: bodyText,
  data: { type: 'reg_of_day', pcgSlug: today.slug },
}))

const BATCH = 100
for (let i = 0; i < messages.length; i += BATCH) {
  const chunk = messages.slice(i, i + BATCH)
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(chunk),
  })
  if (!res.ok) {
    console.error(`Expo push API returned ${res.status} for batch starting at ${i}`)
    continue
  }
  const json = await res.json()
  const errors = (json.data ?? []).filter((r) => r.status === 'error')
  if (errors.length) {
    console.error(`${errors.length} of ${chunk.length} messages in batch failed:`, errors.slice(0, 3))
  }
}

console.log('Done.')
