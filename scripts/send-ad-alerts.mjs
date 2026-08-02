// Sends targeted "New/Updated AD" push notifications for whatever ADs the
// current sync run actually touched — matched per-user against their own
// My Aircraft list (user_aircraft), not a blanket broadcast like AC Update
// Alerts. This IS the actual "highly valuable" payoff of the whole AD
// expansion per explicit direction: a pilot/owner/mechanic only cares
// about the handful of ADs touching an aircraft they actually fly, not a
// firehose across 17,000+ documents.
//
// Run from the ac-app/ directory, after ad_scraper.py has produced its
// --touched-out file for this run:
//   node scripts/send-ad-alerts.mjs --touched-file=<path>
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper (bypasses
// RLS). Keys are never printed. If the touched-file is missing/empty, this
// is a no-op.
//
// Matching is MAKE-first (case-insensitive exact match against
// user_aircraft.make), then narrowed to only the users whose saved MODEL
// string actually appears somewhere in the AD's own model text — an AD's
// model field is often a list ("B300 and B300C", "DA 42, DA 42 M-NG, and
// DA 42 NG"), so a plain equality check would miss real matches; a
// substring check is deliberately permissive rather than trying to fully
// parse every possible model-list format an AD might use.
//
// 2026-07-28: ALSO matches on tagged equipment (user_aircraft_equipment),
// independent of airframe make/model -- this is the actual payoff of the
// parts-catalog feature: an AD keyed to a specific part ("AWI mufflers...
// installed on but not limited to the airplanes listed...", the real
// example that motivated this whole feature, see flyregs_decisions.md)
// would never match on make/model alone if the user's airframe isn't in
// that AD's own model text, but WOULD match if they've tagged that exact
// part on their aircraft.

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

const touchedFileArg = process.argv.find((a) => a.startsWith('--touched-file='))
const touchedFilePath = touchedFileArg ? touchedFileArg.split('=')[1] : null
if (!touchedFilePath || !fs.existsSync(touchedFilePath)) {
  console.log('No touched-file provided or file missing — nothing to notify.')
  process.exit(0)
}

const touchedAdNumbers = fs
  .readFileSync(touchedFilePath, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

if (touchedAdNumbers.length === 0) {
  console.log('Touched-file is empty — no ADs changed this run, nothing to notify.')
  process.exit(0)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const { data: ads, error: adErr } = await sb
  .from('airworthiness_directives')
  .select('ad_number, subject_heading, make, model, applicability')
  .in('ad_number', touchedAdNumbers)

if (adErr) {
  console.error('Failed to fetch touched ADs:', adErr.message)
  process.exit(1)
}
if (!ads || ads.length === 0) {
  console.log('None of the touched AD numbers were found in the DB — nothing to notify.')
  process.exit(0)
}

// Every user_aircraft row, joined against push_tokens by user_id — small
// tables (My Aircraft is deliberately lightweight, one row per saved
// aircraft), so pulling both fully into memory and matching in JS is
// simpler and plenty fast, rather than a per-AD SQL query in a loop.
const [{ data: aircraft, error: acErr }, { data: tokens, error: tokErr }, { data: equipMentions, error: mentErr }, { data: equipTags, error: tagErr }] = await Promise.all([
  sb.from('user_aircraft').select('id, user_id, make, model, type_designator'),
  sb.from('push_tokens').select('user_id, expo_push_token').eq('enabled', true),
  sb.from('ad_part_mentions').select('ad_number, part_id').in('ad_number', touchedAdNumbers),
  sb.from('user_aircraft_equipment').select('user_aircraft_id, part_id'),
])
if (acErr) {
  console.error('Failed to fetch user_aircraft:', acErr.message)
  process.exit(1)
}
if (tokErr) {
  console.error('Failed to fetch push_tokens:', tokErr.message)
  process.exit(1)
}
if (mentErr) {
  console.error('Failed to fetch ad_part_mentions:', mentErr.message)
  process.exit(1)
}
if (tagErr) {
  console.error('Failed to fetch user_aircraft_equipment:', tagErr.message)
  process.exit(1)
}
if (!aircraft || aircraft.length === 0) {
  console.log('No user_aircraft rows saved by anyone yet — nothing to notify.')
  process.exit(0)
}

const tokensByUser = new Map()
for (const t of tokens ?? []) {
  if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, [])
  tokensByUser.get(t.user_id).push(t.expo_push_token)
}

const aircraftById = new Map((aircraft ?? []).map((a) => [a.id, a]))

// part_id -> [ad_number, ...] for this run's touched ADs
const adNumbersByPartId = new Map()
for (const m of equipMentions ?? []) {
  if (!adNumbersByPartId.has(m.part_id)) adNumbersByPartId.set(m.part_id, [])
  adNumbersByPartId.get(m.part_id).push(m.ad_number)
}

// part_id -> [user_aircraft rows tagged with it]
const aircraftByPartId = new Map()
for (const tag of equipTags ?? []) {
  const ac = aircraftById.get(tag.user_aircraft_id)
  if (!ac) continue
  if (!aircraftByPartId.has(tag.part_id)) aircraftByPartId.set(tag.part_id, [])
  aircraftByPartId.get(tag.part_id).push(ac)
}

const adsByNumber = new Map(ads.map((ad) => [ad.ad_number, ad]))

// Every real match, aircraft-level (not just user-level) -- this is what
// the user_ad_notifications table exists for: the in-app "new AD in
// your aircraft folder" marker needs to know WHICH aircraft matched, not
// just which user, and it fires independent of whether that user has a
// working push token (push is layered on top, not a precondition -- a
// user with a matching aircraft but no enabled device still gets the
// in-app marker, just no push).
// key: `${userAircraftId}:${adNumber}` -> { userId, userAircraftId, ad, matchedVia }
const matches = new Map()
const addMatch = (userId, userAircraftId, ad, matchedVia) => {
  const key = `${userAircraftId}:${ad.ad_number}`
  if (matches.has(key)) return
  matches.set(key, { userId, userAircraftId, ad, matchedVia })
}

for (const ad of ads) {
  if (!ad.make) continue
  const adMake = ad.make.trim().toLowerCase()
  const adModel = (ad.model ?? '').toLowerCase()
  // Fallback text checked when ad.model is null -- see the block below for
  // why (RC, live, screenshot: a Cessna 172S showed 65 Applicable ADs,
  // most for entirely different Cessna models). applicability is full,
  // untruncated FR text; subject_heading is hard-truncated to 65 chars at
  // ingest (confirmed by direct query) so it only catches a model name
  // that happens to land in the title's first ~65 characters -- still
  // strictly better than no check at all, which is what this used to fall
  // straight through to.
  const adFallbackText = (ad.applicability ?? ad.subject_heading ?? '').toLowerCase()
  for (const a of aircraft) {
    // Confirmed a real, severe bug live (2026-07-29): this was an EXACT
    // string equality check, but airworthiness_directives.make is the
    // FAA's own long-form type-certificate-holder string ("Textron
    // Aviation Inc. (Type Certificate Previously Held by Cessna Aircraft
    // Company)"), never the common name a user would actually type
    // ("Cessna"). Exact equality meant a saved aircraft could NEVER match
    // any AD for its own manufacturer -- this whole feature's core
    // promise (get alerted about ADs on YOUR plane) was silently broken
    // for effectively every real user. Bidirectional substring match
    // fixes this the same permissive way the model check right below
    // already handles AD model-list strings, and for the same reason:
    // occasionally over-matching costs far less than the alert never
    // firing at all.
    const userMake = a.make.trim().toLowerCase()
    if (!adMake.includes(userMake) && !userMake.includes(adMake)) continue
    // Real AD applicability text is written against the FAA type
    // designator ("PA-28-181", "LA-4-200"), not the marketing name a pilot
    // knows their plane by ("Warrior", "Buccaneer") -- a saved model of
    // "Buccaneer" would never substring-match an AD's "LA-4" model text.
    // type_designator (src/lib/aircraftModels.ts's alias bridge, entered
    // via My Aircraft) is an alternate value to check for the same AD; a
    // match on EITHER the marketing model or the type designator counts.
    const userType = (a.type_designator ?? '').trim().toLowerCase()
    const userModel = a.model.trim().toLowerCase()
    if (adModel) {
      // Structured model column populated -- most precise, unchanged.
      if (!adModel.includes(userModel) && !(userType && adModel.includes(userType))) continue
    } else if (adFallbackText) {
      // REVISED 2026-08-01 (see this file's own header + flyregs_decisions.md
      // for the full measured scope: 1,592/5,023 ADs corpus-wide, and
      // ~75% of Cessna's specifically, have model = NULL -- "occasional"
      // was the original premise for matching on make alone here, and it
      // was wrong). Check the fallback text before assuming a match.
      if (!adFallbackText.includes(userModel) && !(userType && adFallbackText.includes(userType))) continue
    }
    // else: genuinely no model text ANYWHERE on this AD -- true last
    // resort, make-only match (the original behavior, now scoped to only
    // the rows that actually need it).
    addMatch(a.user_id, a.id, ad, 'airframe')
  }
}

// Part-keyed match, independent of airframe make/model — see this
// script's own header comment for why this direction matters.
for (const [partId, adNumbers] of adNumbersByPartId) {
  const taggedAircraft = aircraftByPartId.get(partId)
  if (!taggedAircraft) continue
  for (const adNumber of adNumbers) {
    const ad = adsByNumber.get(adNumber)
    if (!ad) continue
    for (const ac of taggedAircraft) {
      addMatch(ac.user_id, ac.id, ad, 'equipment')
    }
  }
}

if (matches.size === 0) {
  console.log(`${ads.length} AD(s) touched this run, but none matched any saved aircraft — nothing to notify.`)
  process.exit(0)
}

console.log(`${matches.size} aircraft/AD match(es) this run.`)

// Write EVERY match to the durable log first, independent of push status --
// this is what makes the in-app "new AD in your aircraft folder" marker
// work for a user with no enabled push token, and what gives this run a
// real audit trail regardless of what happens with Expo below. on_conflict
// does nothing on an existing (aircraft, AD) row so a re-touched AD never
// resets an already-read notification back to unread.
const logRows = [...matches.values()].map((m) => ({
  user_id: m.userId,
  user_aircraft_id: m.userAircraftId,
  ad_number: m.ad.ad_number,
  matched_via: m.matchedVia,
}))
{
  const LOG_BATCH = 500
  for (let i = 0; i < logRows.length; i += LOG_BATCH) {
    const { error: logErr } = await sb
      .from('user_ad_notifications')
      .upsert(logRows.slice(i, i + LOG_BATCH), { onConflict: 'user_aircraft_id,ad_number', ignoreDuplicates: true })
    if (logErr) {
      // Not fatal -- the push below is still real and worth attempting --
      // but this must be loud, since a failure here is exactly the kind
      // of silent gap this table exists to prevent.
      console.error(`FAILED to write ${logRows.length - i} notification-log row(s):`, logErr.message)
    }
  }
}

// Group by user for the push step (unchanged bundling logic: one
// notification per user combining every aircraft/AD match they have this
// run), but keep the per-match keys so a delivery result can be written
// back to the specific log rows below.
const matchKeysByUser = new Map()
for (const [key, m] of matches) {
  if (!tokensByUser.has(m.userId)) continue // no enabled device, nothing to push
  if (!matchKeysByUser.has(m.userId)) matchKeysByUser.set(m.userId, [])
  matchKeysByUser.get(m.userId).push(key)
}

if (matchKeysByUser.size === 0) {
  console.log('No matched user has an enabled push token — folder markers written, nothing to push.')
  process.exit(0)
}

console.log(`Sending targeted AD alerts to ${matchKeysByUser.size} user(s)...`)

const messages = []
for (const [userId, keys] of matchKeysByUser) {
  const uniqueAds = [...new Map(keys.map((k) => [matches.get(k).ad.ad_number, matches.get(k).ad])).values()]
  const title =
    uniqueAds.length === 1 ? `New AD for your aircraft: ${uniqueAds[0].ad_number}` : `${uniqueAds.length} new ADs for your aircraft`
  const body =
    uniqueAds.length === 1
      ? uniqueAds[0].subject_heading
      : uniqueAds.slice(0, 3).map((a) => `AD ${a.ad_number}`).join(', ') + (uniqueAds.length > 3 ? ', and more' : '')
  for (const expoPushToken of tokensByUser.get(userId)) {
    messages.push({
      to: expoPushToken,
      sound: 'default',
      title,
      body,
      data: { adNumbers: uniqueAds.map((a) => a.ad_number) },
      // Not sent to Expo -- stripped before the request below. Carried
      // alongside so a per-token delivery result can be folded back into
      // this user's own match keys once the batch response comes back.
      _userId: userId,
    })
  }
}

// One outcome per user (not per-token/device): a real push failure on one
// of a user's several devices shouldn't mark the notification as
// undelivered if it succeeded on another. Upgrades to 'sent' on any 'ok'
// ticket; otherwise records the last real error seen.
const pushResultByUser = new Map()

const BATCH = 100
for (let i = 0; i < messages.length; i += BATCH) {
  const chunk = messages.slice(i, i + BATCH)
  const payload = chunk.map(({ _userId, ...m }) => m)
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const errText = `Expo push API returned ${res.status} for batch starting at ${i}`
    console.error(errText)
    for (const m of chunk) {
      const prev = pushResultByUser.get(m._userId)
      if (!prev || prev.status !== 'sent') pushResultByUser.set(m._userId, { status: 'error', error: errText })
    }
    continue
  }
  const json = await res.json()
  const tickets = json.data ?? []
  const errors = tickets.filter((r) => r.status === 'error')
  if (errors.length) {
    console.error(`${errors.length} of ${chunk.length} messages in batch failed:`, errors.slice(0, 3))
  }
  tickets.forEach((ticket, idx) => {
    const userId = chunk[idx]._userId
    if (ticket.status === 'ok') {
      pushResultByUser.set(userId, { status: 'sent', error: null })
    } else {
      const prev = pushResultByUser.get(userId)
      if (!prev || prev.status !== 'sent') {
        pushResultByUser.set(userId, { status: 'error', error: ticket.message ?? 'unknown Expo error' })
      }
    }
  })
}

// Fold delivery results back into the durable log so "was this user
// actually notified" has a real answer after the fact, not just a CI log
// line. Runs even if some rows above failed to write -- an upsert with
// ignoreDuplicates:false here so an existing row's push fields DO get
// filled in (unlike the log-write step above, which must NOT clobber an
// already-read notification's state).
const updateRows = []
for (const [userId, keys] of matchKeysByUser) {
  const result = pushResultByUser.get(userId)
  if (!result) continue
  for (const key of keys) {
    const m = matches.get(key)
    updateRows.push({
      user_id: m.userId,
      user_aircraft_id: m.userAircraftId,
      ad_number: m.ad.ad_number,
      matched_via: m.matchedVia,
      push_status: result.status,
      push_error: result.error,
      push_sent_at: new Date().toISOString(),
    })
  }
}
{
  const UPD_BATCH = 500
  for (let i = 0; i < updateRows.length; i += UPD_BATCH) {
    const { error: updErr } = await sb
      .from('user_ad_notifications')
      .upsert(updateRows.slice(i, i + UPD_BATCH), { onConflict: 'user_aircraft_id,ad_number' })
    if (updErr) {
      console.error(`FAILED to record push delivery status for ${updateRows.length - i} row(s):`, updErr.message)
    }
  }
}

const sentCount = [...pushResultByUser.values()].filter((r) => r.status === 'sent').length
const errorCount = pushResultByUser.size - sentCount
console.log(`Done. Push delivered to ${sentCount} user(s), failed for ${errorCount}. All matches logged to user_ad_notifications.`)
if (errorCount > 0) {
  // Loud but not fatal -- see this file's header: a delivery failure for
  // some users must never block the ones who succeeded, but it must be
  // impossible to miss in the run's own summary line, and it's now also
  // durably queryable via user_ad_notifications.push_status = 'error'
  // instead of only existing in this ephemeral log.
  console.error(`WARNING: ${errorCount} user(s) matched a new AD but push delivery failed. See user_ad_notifications.push_error.`)
}
