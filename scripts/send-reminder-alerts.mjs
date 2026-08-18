// Sends a push notification for each user_aircraft_reminders row entering
// its "due soon" window (due within 14 days, including anything already
// overdue) that hasn't been notified about yet. Reuses the exact same
// Expo push infra as scripts/send-reg-of-day.mjs / send-ad-alerts.mjs --
// same push_tokens table, same exp.host API call shape.
//
// Sends ONCE per reminder (tracked via notified_at) rather than repeating
// daily — the schema has no "dismissed"/"snoozed" concept, so a repeat
// notification would just be noise; if the user wants another nudge they
// can re-add the reminder. 100% user-input-driven, matching this feature's
// whole design: the app does date math and notifies, it verifies nothing
// independently ("may be due" framing in the push copy itself, not a
// compliance claim).
//
// Run daily via .github/workflows/daily-reminder-alerts.yml:
//   node scripts/send-reminder-alerts.mjs
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper.

import { createClient } from '@supabase/supabase-js'
import { fetchHiddenAircraftIds } from './lib/tier-cap.mjs'
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

const WINDOW_DAYS = 14
const windowEnd = new Date()
windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS)
const windowEndStr = windowEnd.toISOString().split('T')[0]

const { data: allReminders, error: remErr } = await sb
  .from('user_aircraft_reminders')
  .select('id, user_id, user_aircraft_id, title, due_date, linked_ad_number, user_aircraft:user_aircraft_id(make, model, nickname)')
  .is('notified_at', null)
  .lte('due_date', windowEndStr)

if (remErr) {
  console.error('Failed to fetch due reminders:', remErr.message)
  process.exit(1)
}

// A reminder on an aircraft the owner's tier no longer shows must not keep
// pushing. This was a live leak, and the one actually landing on a phone:
// reminders were fetched with no tier check whatsoever, so an account that
// downgraded Premium -> Pro kept getting daily reminder pushes for every
// aircraft it had ever saved -- including the ones My Aircraft correctly
// stopped listing. Uses the exact same shared rule as the fleet RPC and
// send-ad-alerts.mjs (scripts/lib/tier-cap.mjs) rather than a fourth
// hand-rolled copy of it. RC: "we can't have any bleed through."
let hiddenIds = new Set()
try {
  hiddenIds = await fetchHiddenAircraftIds(sb)
} catch (e) {
  // Fail OPEN, matching the rest of the cap: a lookup failure must never
  // silently swallow a paying customer's real maintenance reminders.
  console.error('Tier-cap lookup failed, sending unfiltered:', e.message)
}
const reminders = (allReminders ?? []).filter((r) => !hiddenIds.has(r.user_aircraft_id))
const skipped = (allReminders?.length ?? 0) - reminders.length
if (skipped > 0) {
  console.log(`${skipped} reminder(s) skipped: on aircraft hidden by their owner's tier cap.`)
}

if (reminders.length === 0) {
  console.log('No reminders entering their notification window — nothing to send.')
  process.exit(0)
}

const { data: tokens, error: tokErr } = await sb
  .from('push_tokens')
  .select('user_id, expo_push_token')
  .eq('enabled', true)
if (tokErr) {
  console.error('Failed to fetch push_tokens:', tokErr.message)
  process.exit(1)
}
const tokensByUser = new Map()
for (const t of tokens ?? []) {
  if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, [])
  tokensByUser.get(t.user_id).push(t.expo_push_token)
}

const today = new Date()
today.setHours(0, 0, 0, 0)

const messages = []
const notifiedIds = []
for (const r of reminders) {
  const deviceTokens = tokensByUser.get(r.user_id)
  if (!deviceTokens || deviceTokens.length === 0) continue // no enabled device -- still mark notified below so it isn't re-checked forever

  const due = new Date(r.due_date + 'T00:00:00')
  const daysUntil = Math.round((due.getTime() - today.getTime()) / 86400000)
  const acLabel = r.user_aircraft?.nickname || (r.user_aircraft ? `${r.user_aircraft.make} ${r.user_aircraft.model}` : 'your aircraft')

  // RC, 2026-08-16: "it's important that the small home/lock screen msg
  // bar... contains a brief indication of what type of notif it is."
  // "Due today: {title}" was the one gap here -- the other two branches
  // already say "Reminder" up front, this one didn't.
  const title = daysUntil < 0 ? `Reminder overdue: ${r.title}` : daysUntil === 0 ? `Reminder due today: ${r.title}` : `Reminder: ${r.title}`
  const overdueDays = Math.abs(daysUntil)
  const body =
    daysUntil < 0
      ? `${overdueDays} day${overdueDays === 1 ? '' : 's'} past due for ${acLabel} — you may want to check this.`
      : daysUntil === 0
        ? `Due today for ${acLabel}.`
        : `Due in ${daysUntil} day${daysUntil === 1 ? '' : 's'} for ${acLabel}.`

  for (const expoPushToken of deviceTokens) {
    messages.push({ to: expoPushToken, sound: 'default', title, body, data: { reminderId: r.id, userAircraftId: r.user_aircraft_id } })
  }
  notifiedIds.push(r.id)
}

// Mark ALL due reminders as notified (even ones with no enabled device) --
// otherwise a user who enables push later would get a flood of stale
// "reminders" for windows that already passed silently.
const allDueIds = reminders.map((r) => r.id)
if (allDueIds.length > 0) {
  const { error: updErr } = await sb
    .from('user_aircraft_reminders')
    .update({ notified_at: new Date().toISOString() })
    .in('id', allDueIds)
  if (updErr) console.error('Failed to mark reminders as notified:', updErr.message)
}

if (messages.length === 0) {
  console.log(`${allDueIds.length} reminder(s) entered their window, but no recipient has push enabled — marked notified, nothing sent.`)
  process.exit(0)
}

console.log(`Sending ${messages.length} reminder notification(s)...`)

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
