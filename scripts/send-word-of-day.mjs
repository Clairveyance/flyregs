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
import { canReceivePlusPush, canReceiveProPush } from './lib/tier-cap.mjs'

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
//
// `enabled` (the AC Update Alerts flag) is deliberately NOT part of this
// query -- same bug, same fix as get_duel_push_target() and
// send-reg-of-day.mjs (see migrations_fix_duel_push_target_enabled_gate.sql):
// enableDailyWord() upserts a brand-new push_tokens row with
// `enabled: existing?.enabled ?? false`, so a user who turns on DailyWord
// without ever touching AC Update Alerts first gets word_of_day_enabled=true
// but enabled=false and silently never receives a DailyWord push despite
// Account showing the toggle ON. The real gate is the Plus-tier filter below.
const { data: tokens, error: tokenErr } = await sb
  .from('push_tokens')
  .select('user_id, expo_push_token')
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
// 2026-08-19/20 gating sweep, real live leak found and fixed: this RPC's
// pool is drawn from ALL of dictionary_terms, and a category='mnemonic'
// row needs has_pro_access() to read (see dictionary_terms_gated's own
// redaction, and the mnemonic-specific Pro paywall on the Dictionary
// detail screen) -- a genuinely HIGHER bar than DailyWord's normal Plus
// gate. This script authenticates as service_role (needed to read the real
// text for the notification body -- see get_word_of_the_day's own
// comment), so nothing upstream stops it from happily building a push for
// a mnemonic day and sending the real text to a Plus-but-not-Pro
// recipient, who'd then see the exact text the in-app detail screen
// correctly paywalls behind Pro. Confirmed live: 52 real mnemonic rows are
// in the pool today, and the date-hash rotation lands on one
// (2026-09-11 -> "5 Ps") within the next month. category now comes back
// from get_word_of_the_day() specifically so this per-day decision can be
// made without a second query.
const requiredGate = today.category === 'mnemonic' ? canReceiveProPush : canReceivePlusPush
const eligible = (tokens ?? []).filter((t) => requiredGate(entByUser.get(t.user_id)))
const skipped = (tokens ?? []).length - eligible.length
if (skipped > 0) console.log(`Skipping ${skipped} device(s) whose tier no longer includes today's DailyWord (${today.category === 'mnemonic' ? 'mnemonic, Pro+' : 'Plus+'}).`)

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
