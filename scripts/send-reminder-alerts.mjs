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

// NOT filtered on `enabled` -- found in tonight's "built but inert" sweep,
// same root cause as send-ad-alerts.mjs: `enabled` is specifically the
// Premium-gated "AC Update Alerts" toggle, not a general "device has a
// working token" signal. Reminders have no dedicated toggle of their own
// either, so this was silently dropping a Pro+ user's maintenance reminder
// forever (see the "mark as notified" comment below) unless they'd
// separately touched an unrelated settings toggle.
const { data: tokens, error: tokErr } = await sb
  .from('push_tokens')
  .select('user_id, expo_push_token')
if (tokErr) {
  console.error('Failed to fetch push_tokens:', tokErr.message)
  process.exit(1)
}
const tokensByUser = new Map()
for (const t of tokens ?? []) {
  if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, [])
  tokensByUser.get(t.user_id).push(t.expo_push_token)
}

// RC, 2026-09-01: "reminders should push in any shared item (folder, a/c, etc)
// - always, when owner is sharing with the person/group, on both r/o and r/w
// perms." So a reminder is not a private note to whoever typed it -- it is the
// shared aircraft's schedule, and everyone with access to that aircraft gets it.
//
// Before this, send-reminder-alerts only ever pushed to r.user_id. Since
// addAircraftReminder() stamps user_id = whoever created it, a reminder added by
// an editor collaborator (a mechanic, a co-owner) pushed ONLY to that person and
// never to the owner -- and an owner's reminder never reached the collaborator.
// send-ad-alerts.mjs already fans out exactly this way; reminders simply never
// got the same treatment. Note NO role filter: read-only collaborators receive
// too, per the spec above -- being unable to edit does not mean you should be
// surprised by an overdue annual on an aircraft you fly.
const [{ data: acOwners, error: ownErr }, { data: acCollabs, error: collabErr }] = await Promise.all([
  sb.from('user_aircraft').select('id, user_id'),
  sb.from('aircraft_collaborators').select('aircraft_id, user_id').is('left_at', null).not('accepted_at', 'is', null),
])
if (ownErr) { console.error('Failed to fetch user_aircraft owners:', ownErr.message); process.exit(1) }
if (collabErr) { console.error('Failed to fetch aircraft_collaborators:', collabErr.message); process.exit(1) }

const ownerByAircraftId = new Map((acOwners ?? []).map((a) => [a.id, a.user_id]))
const collaboratorsByAircraftId = new Map()
for (const c of acCollabs ?? []) {
  if (!collaboratorsByAircraftId.has(c.aircraft_id)) collaboratorsByAircraftId.set(c.aircraft_id, [])
  collaboratorsByAircraftId.get(c.aircraft_id).push(c.user_id)
}

/** Everyone who should hear about this reminder: the aircraft's owner and every
 *  accepted collaborator still on it.
 *
 *  The author (reminder.user_id) is included ONLY when they are still one of
 *  those two. Until 2026-09-03 they were included unconditionally, and
 *  removeCollaborator() hard-deletes the membership row while leaving behind
 *  the reminders that person authored -- so a removed mechanic or ex-co-owner
 *  kept receiving "Reminder overdue: Annual Inspection - 3 days past due for
 *  N12345", which both discloses the aircraft's maintenance state to someone
 *  no longer entitled to it and deep-links to a screen has_aircraft_access()
 *  correctly denies them.
 *
 *  The original "never lose the creator" fallback is kept, but now applies only
 *  to the case it was actually written for: the aircraft row itself missing. */
function recipientsFor(reminder) {
  const owner = ownerByAircraftId.get(reminder.user_aircraft_id)
  const collabs = collaboratorsByAircraftId.get(reminder.user_aircraft_id) ?? []
  if (!owner) return [reminder.user_id].filter(Boolean)
  return [...new Set([owner, ...collabs].filter(Boolean))]
}

const today = new Date()
today.setHours(0, 0, 0, 0)

const messages = []
for (const r of reminders) {
  const deviceTokens = recipientsFor(r).flatMap((uid) => tokensByUser.get(uid) ?? [])
  if (deviceTokens.length === 0) continue // nobody on this aircraft has a registered device -- still marked notified below so it isn't re-checked forever

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
    // type: found missing in tonight's sweep -- with no `type` field,
    // _layout.tsx's tap handler fell through every branch and did nothing.
    // _reminderId is carried alongside the Expo payload so a per-message
    // result can be mapped back to the row it belongs to; it is stripped
    // before the request body is built.
    messages.push({ _reminderId: r.id, to: expoPushToken, sound: 'default', title, body, data: { type: 'reminder', reminderId: r.id, userAircraftId: r.user_aircraft_id } })
  }
}

// A reminder with NO registered device at all is still marked notified -- that
// part is deliberate and unchanged: otherwise a user who enables push later
// gets a flood of stale windows that already passed.
//
// What changed (2026-09-01): this used to mark EVERY due reminder as notified
// BEFORE sending. So if the Expo API returned non-2xx, or an individual message
// came back status:'error', that reminder was already stamped and would never
// be retried -- an annual or pitot-static due date silently disappearing with
// no trace and no way to get it back, since nothing re-arms a reminder except a
// genuine due_date change. A reminder we actually attempt to send is now only
// marked once Expo accepts it, so a transient failure retries on tomorrow's run.
const noTokenIds = reminders.filter((r) => recipientsFor(r).every((uid) => !(tokensByUser.get(uid) || []).length)).map((r) => r.id)

if (messages.length === 0) {
  if (noTokenIds.length > 0) {
    const { error: updErr } = await sb
      .from('user_aircraft_reminders')
      .update({ notified_at: new Date().toISOString() })
      .in('id', noTokenIds)
    if (updErr) console.error('Failed to mark reminders as notified:', updErr.message)
  }
  console.log(`${reminders.length} reminder(s) entered their window, but no recipient has a registered push token — marked notified, nothing sent.`)
  process.exit(0)
}

console.log(`Sending ${messages.length} reminder notification(s)...`)

const sentReminderIds = new Set()
// Tracked SEPARATELY from sentReminderIds because a reminder's recipients are
// DIFFERENT PEOPLE (owner + collaborators), not one person's several devices.
// The mechanic's push succeeding must never mark the OWNER's overdue annual as
// delivered -- and nothing re-arms a reminder except a genuine due_date change,
// so a wrongly-marked row is lost permanently and silently. Any real failure
// for any recipient holds the whole row back for tomorrow's retry: a duplicate
// nudge is recoverable, a missed annual is not.
const failedReminderIds = new Set()
const BATCH = 100
for (let i = 0; i < messages.length; i += BATCH) {
  const chunk = messages.slice(i, i + BATCH)
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(chunk.map(({ _reminderId, ...m }) => m)),
  })
  if (!res.ok) {
    console.error(`Expo push API returned ${res.status} for batch starting at ${i} — leaving those reminders unnotified for tomorrow's retry`)
    for (const m of chunk) failedReminderIds.add(m._reminderId)
    continue
  }
  const json = await res.json()
  const results = json.data
  // A missing or short ticket array is NOT success. Expo can answer HTTP 200
  // with an {"errors":[...]} envelope and no `data` at all -- `json.data ?? []`
  // then made every ticket undefined, and the old `!r ||` branch read that as
  // delivered and stamped notified_at on the ENTIRE batch of up to 100. Real
  // annuals, ELT batteries, transponder and pitot-static checks would vanish
  // with no trace and no user-visible symptom.
  if (!Array.isArray(results) || results.length !== chunk.length) {
    console.error(
      `Expo returned ${Array.isArray(results) ? results.length : 'no'} ticket(s) for ${chunk.length} message(s) in the batch starting at ${i} — leaving those reminders unnotified for tomorrow's retry`,
      json.errors ?? '',
    )
    for (const m of chunk) failedReminderIds.add(m._reminderId)
    continue
  }
  chunk.forEach((m, idx) => {
    const r = results[idx]
    // DeviceNotRegistered is terminal, not transient -- the token is dead and
    // retrying it every day forever is worse than accepting it as delivered as
    // far as we can deliver it.
    if (r.status !== 'error' || r.details?.error === 'DeviceNotRegistered') {
      sentReminderIds.add(m._reminderId)
    } else {
      failedReminderIds.add(m._reminderId)
    }
  })
  // Prune dead tokens rather than only skipping them. DeviceNotRegistered is
  // terminal: the device uninstalled or revoked notifications. Nothing in this
  // app has ever removed a row from push_tokens, so a dead token would sit in
  // every daily and weekly batch forever -- and because Expo can REASSIGN a
  // token to a different device, a stale row is a misroute risk, not just
  // wasted quota. Only 2 rows live today, so this is preventive.
  const deadTokens = [...new Set(
    chunk.filter((_, idx) => results[idx]?.details?.error === 'DeviceNotRegistered').map((m) => m.to),
  )]
  if (deadTokens.length) {
    const { error: delErr } = await sb.from('push_tokens').delete().in('expo_push_token', deadTokens)
    if (delErr) console.error('Failed to prune dead push tokens:', delErr.message)
    else console.log(`Pruned ${deadTokens.length} DeviceNotRegistered token(s).`)
  }

  const errors = results.filter((r) => r.status === 'error')
  if (errors.length) {
    console.error(`${errors.length} of ${chunk.length} messages in batch failed:`, errors.slice(0, 3))
  }
}

// A failure for ANY recipient wins over a success for another -- see
// failedReminderIds' own comment.
const toMark = [...new Set([...noTokenIds, ...sentReminderIds])].filter((id) => !failedReminderIds.has(id))
if (toMark.length > 0) {
  const { error: updErr } = await sb
    .from('user_aircraft_reminders')
    .update({ notified_at: new Date().toISOString() })
    .in('id', toMark)
  if (updErr) console.error('Failed to mark reminders as notified:', updErr.message)
}

console.log(`Done. ${toMark.length} of ${reminders.length} reminder(s) marked notified.`)
