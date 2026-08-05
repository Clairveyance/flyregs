// Sends the daily "DailyReg" push notification (Pro/Premium, opt-in
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
import { canReceiveProPush } from './lib/tier-cap.mjs'

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

const { data: dailyReg, error: rodErr } = await sb.rpc('get_reg_of_the_day')
if (rodErr) {
  console.error('get_reg_of_the_day RPC failed:', rodErr.message)
  process.exit(1)
}
const today = dailyReg?.[0]
if (!today) {
  console.error('get_reg_of_the_day returned no row -- pcg_terms empty?')
  process.exit(1)
}

// user_id too, so the Pro gate below can be applied per recipient. DailyReg
// is a Pro feature and this used to send on the opt-in flag alone -- see
// canReceiveProPush in lib/tier-cap.mjs for why that leaked.
const { data: tokens, error: tokenErr } = await sb
  .from('push_tokens')
  .select('user_id, expo_push_token')
  .eq('enabled', true)
  .eq('reg_of_day_enabled', true)

if (tokenErr) {
  console.error('Failed to fetch push tokens:', tokenErr.message)
  process.exit(1)
}

const { data: entitlements, error: entErr } = await sb
  .from('user_entitlements')
  .select('user_id, is_pro, is_premium')
if (entErr) {
  console.error('Failed to fetch user_entitlements:', entErr.message)
  process.exit(1)
}
const entByUser = new Map((entitlements ?? []).map((e) => [e.user_id, e]))
// Pro gate applied here, after the opt-in filter: a lapsed subscriber keeps
// reg_of_day_enabled = true forever (nothing ever rewrites push_tokens on a
// downgrade), so the entitlement is the only thing that can stop this.
const eligible = (tokens ?? []).filter((t) => canReceiveProPush(entByUser.get(t.user_id)))
const skipped = (tokens ?? []).length - eligible.length
if (skipped > 0) console.log(`Skipping ${skipped} device(s) whose tier no longer includes DailyReg.`)

if (!eligible || eligible.length === 0) {
  console.log('No devices opted into DailyReg -- nothing to send.')
  process.exit(0)
}

console.log(`Sending "${today.term}" to ${eligible.length} device(s).`)

// Truncated to a single readable line -- this is a lock-screen notification
// body, not the full glossary entry; tapping it opens the real definition
// in-app (see data.slug/sourceType, read by the app's notification-response
// handler in _layout.tsx).
const bodyText = today.definition.length > 120 ? `${today.definition.slice(0, 117)}...` : today.definition

// RC: "when the DailyReg is expanded or pushed to devices, it needs to show
// the reg that it came from at the bottom, so user can see that (just like
// the fix we did for study cards)." Deliberately duplicated from
// src/lib/notifications.ts's dailyRegCitation() rather than imported --
// this is a plain Node script with no bundler/alias resolution, and the
// shape it formats (get_reg_of_the_day's slug + source_type) is the same
// contract on both sides. Keep the two in step.
const citation =
  today.source_type === 'far' ? `14 CFR § ${today.slug}`
  : today.source_type === 'aim' ? `AIM ${today.slug}`
  : `AC ${today.slug}`

// get_reg_of_the_day() rotates FAR/AIM/AC (P/CG deliberately excluded --
// see notifications.ts's DailyRegSource comment) -- the deep link has
// to carry which one so the tap handler routes to /far, /aim, or /ac
// correctly.
const messages = eligible.map((t) => ({
  to: t.expo_push_token,
  sound: 'default',
  title: `DailyReg — ${citation}`,
  body: `${today.term}\n${bodyText}`,
  data: { type: 'reg_of_day', slug: today.slug, sourceType: today.source_type },
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
