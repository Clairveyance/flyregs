// Sends the daily "DailyWord" push notification (Plus/Pro/Premium, opt-in
// toggle separate from DailyReg/AC Update Alerts) -- a rotating Aviation
// Dictionary term. Mirrors send-reg-of-day.mjs's structure exactly, with
// one deliberate difference: DailyWord's own content gate is Plus
// (has_plus_access() in Postgres), not Pro like DailyReg -- confirmed live
// via get_word_of_the_day()'s own SQL before writing this, RC: "the push
// not. should gate to same tier that gets the DW itself."
//
// Meant to run once per day via its own scheduled workflow, same reasoning
// as send-reg-of-day.mjs (nothing to do with content changing that week).
//
// Run from the ac-app/ directory:
//   node scripts/send-word-of-day.mjs
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper (bypasses
// RLS, needed to read every opted-in push_tokens row across all users).

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { canReceivePlusPush } from './lib/tier-cap.mjs'

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

const { data: dailyWord, error: wodErr } = await sb.rpc('get_word_of_the_day')
if (wodErr) {
  console.error('get_word_of_the_day RPC failed:', wodErr.message)
  process.exit(1)
}
const today = dailyWord?.[0]
if (!today || !today.definition) {
  // definition null here means the service_role bypass in
  // get_word_of_the_day() isn't live yet (see
  // sync/migrations_dailyword_push_and_duel_copy.sql) -- fail loud rather
  // than silently sending a body-less notification.
  console.error('get_word_of_the_day returned no row or a redacted definition -- dictionary_terms empty, or the service_role bypass is missing.')
  process.exit(1)
}

// user_id too, so the Plus gate below can be applied per recipient. Same
// reasoning as send-reg-of-day.mjs's Pro gate: the opt-in flag alone
// (word_of_day_enabled) survives a downgrade untouched.
const { data: tokens, error: tokenErr } = await sb
  .from('push_tokens')
  .select('user_id, expo_push_token')
  .eq('enabled', true)
  .eq('word_of_day_enabled', true)

if (tokenErr) {
  console.error('Failed to fetch push tokens:', tokenErr.message)
  process.exit(1)
}

const { data: entitlements, error: entErr } = await sb
  .from('user_entitlements')
  .select('user_id, is_unlocked, is_pro, is_premium')
if (entErr) {
  console.error('Failed to fetch user_entitlements:', entErr.message)
  process.exit(1)
}
const entByUser = new Map((entitlements ?? []).map((e) => [e.user_id, e]))
const eligible = (tokens ?? []).filter((t) => canReceivePlusPush(entByUser.get(t.user_id)))
const skipped = (tokens ?? []).length - eligible.length
if (skipped > 0) console.log(`Skipping ${skipped} device(s) whose tier no longer includes DailyWord.`)

if (!eligible || eligible.length === 0) {
  console.log('No devices opted into DailyWord -- nothing to send.')
  process.exit(0)
}

console.log(`Sending "${today.term}" to ${eligible.length} device(s).`)

// Truncated to a single readable line -- same reasoning as
// send-reg-of-day.mjs's bodyText.
const bodyText = today.definition.length > 120 ? `${today.definition.slice(0, 117)}...` : today.definition

// "DailyWord — {term}" mirrors DailyReg's own "DailyReg — {citation}" title
// shape exactly -- same glance-identifiable prefix pattern, so a user
// seeing several FlyRegs notifications stacked can tell them apart without
// opening any of them.
const messages = eligible.map((t) => ({
  to: t.expo_push_token,
  sound: 'default',
  title: `DailyWord — ${today.term}`,
  body: bodyText,
  data: { type: 'word_of_day', slug: today.slug },
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
