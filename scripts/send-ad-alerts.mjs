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
import { hiddenAircraftIds, canReceiveAdPush } from './lib/tier-cap.mjs'

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
const [{ data: allAircraft, error: acErr }, { data: tokens, error: tokErr }, { data: equipMentions, error: mentErr }, { data: equipTags, error: tagErr }, { data: collabs, error: collabErr }, { data: entitlements, error: entErr }] = await Promise.all([
  sb.from('user_aircraft').select('id, user_id, make, model, type_designator, created_at'),
  // NOT filtered on `enabled` -- found in tonight's "built but inert" sweep:
  // `enabled` is specifically the Premium-gated "AC Update Alerts" toggle
  // (the only code path that ever sets it), but faq.tsx tells users AD
  // alerts are "automatic once you've saved an aircraft and have push
  // notifications enabled" -- no separate toggle exists for this feature at
  // all. A real Premium fleet owner who never happened to visit the
  // unrelated AC-alerts toggle got zero AD pushes on a safety-relevant
  // feature the app's own FAQ promises is automatic. Any row here means the
  // device has SOME real registered token, which is what "automatic" means
  // for a feature with no dedicated switch -- same fix shape already
  // applied to collaboration invites (migrations_collaboration_invite_
  // push_unlink_ac_alerts.sql) and already true of Duels.
  sb.from('push_tokens').select('user_id, expo_push_token'),
  sb.from('ad_part_mentions').select('ad_number, part_id').in('ad_number', touchedAdNumbers),
  sb.from('user_aircraft_equipment').select('user_aircraft_id, part_id'),
  // accepted_at NOT NULL as well as left_at NULL -- a pending Callsign
  // invite is a row on this table too (invite_aircraft_collaborator()
  // inserts it with accepted_at null and only join_shared_aircraft() stamps
  // it), so filtering on left_at alone treated INVITED-but-never-joined
  // people as active team members and pushed them "New AD for your
  // aircraft" for an aircraft they have no access to and cannot open --
  // has_aircraft_access() requires accepted_at, so the in-app follow-through
  // is a dead end for them. Every other reader of this table pairs the two
  // conditions (has_aircraft_access, get_fleet_summary, get_my_shared_
  // aircraft, getMyAircraftRole); this was the one place that didn't.
  sb.from('aircraft_collaborators').select('aircraft_id, user_id').is('left_at', null).not('accepted_at', 'is', null),
  sb.from('user_entitlements').select('user_id, is_premium'),
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
if (collabErr) {
  console.error('Failed to fetch aircraft_collaborators:', collabErr.message)
  process.exit(1)
}
if (entErr) {
  console.error('Failed to fetch user_entitlements:', entErr.message)
  process.exit(1)
}
if (!allAircraft || allAircraft.length === 0) {
  console.log('No user_aircraft rows saved by anyone yet — nothing to notify.')
  process.exit(0)
}

// Third layer of the saved-aircraft tier cap, and the one that actually
// reaches a pocket. RC, 2026-08-05: "a Pro user would never get a note
// about 'tracking 4 a/c' b/c that's not possible with Pro... we can't
// have any bleed through" -- and this script was the worst of it, because
// an account that downgrades Premium -> Pro kept getting real push alerts
// for every aircraft it had ever saved, forever. Mirrors
// fleet_visible_cap()/get_fleet_summary() in
// sync/migrations_tier_cap_enforcement.sql exactly: non-Premium keeps
// only its oldest PRO_AIRCRAFT_CAP owned aircraft, a MISSING entitlement
// row means uncapped (never punish a paying customer for a sync hiccup),
// and nothing is deleted -- these rows still exist and come straight back
// on re-subscribe.
const entByUser = new Map((entitlements ?? []).map((e) => [e.user_id, e]))
const cappedOutIds = hiddenAircraftIds(allAircraft, entitlements)
const aircraft = allAircraft.filter((a) => !cappedOutIds.has(a.id))
if (cappedOutIds.size > 0) {
  console.log(`${cappedOutIds.size} saved aircraft skipped: over their owner's non-Premium cap (hidden in-app too, not deleted).`)
}
if (aircraft.length === 0) {
  console.log('Every saved aircraft is over its owner\'s tier cap — nothing to notify.')
  process.exit(0)
}

const tokensByUser = new Map()
for (const t of tokens ?? []) {
  if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, [])
  tokensByUser.get(t.user_id).push(t.expo_push_token)
}

const aircraftById = new Map((aircraft ?? []).map((a) => [a.id, a]))

// aircraft_id -> [collaborator user_id, ...], active memberships only. An
// AD alert is a team-maintenance concern, not a solo one -- RC: "the push
// logic is that this 'group' push only happens if an a/c folder is
// shared, and has to make sure to fire to all people listed in that, but
// also ONLY to the people listed in that group." An aircraft with no
// collaborators here naturally falls back to owner-only, unchanged.
const collaboratorsByAircraftId = new Map()
for (const c of collabs ?? []) {
  if (!collaboratorsByAircraftId.has(c.aircraft_id)) collaboratorsByAircraftId.set(c.aircraft_id, [])
  collaboratorsByAircraftId.get(c.aircraft_id).push(c.user_id)
}

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

// Mirrors sync/migrations_general_aircraft_designator_normalization.sql's
// normalize_aircraft_designator() exactly -- this script is a SEPARATE JS
// implementation of the same match, not a caller of the SQL RPC, so it has
// to carry the identical fix or the two silently diverge (a real AD-owner
// would get an in-app match from backfill_aircraft_ad_notifications() but
// never a push alert here, or vice versa). RC: "our aircraft matching...
// has to be much fuzzier... expanded now because there are several other
// manufacturers." Confirmed live against the corpus first (Diamond "DA 40"
// vs owner-typed "DA40"; Piper PDF-artifact "PA-28- 161") before building --
// see the SQL migration's header comment for the full investigation and for
// why a pg_trgm fuzzy fallback was deliberately NOT added here (adjacent
// real variants like PA-28-180/181 and 172R/172RG score too close to real
// typos to threshold safely).
const normalizeDesignator = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const stripCessnaPrefix = (make, normalized) =>
  make.includes('cessna') && /^c[0-9]/.test(normalized) ? normalized.slice(1) : normalized

// Every real match, aircraft-level (not just user-level) -- this is what
// the user_ad_notifications table exists for: the in-app "new AD in
// your aircraft folder" marker needs to know WHICH aircraft matched, not
// just which user, and it fires independent of whether that user has a
// working push token (push is layered on top, not a precondition -- a
// user with a matching aircraft but no registered device still gets the
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
  const adModel = normalizeDesignator(ad.model ?? '')
  // Fallback text checked when ad.model is null -- see the block below for
  // why (RC, live, screenshot: a Cessna 172S showed 65 Applicable ADs,
  // most for entirely different Cessna models). applicability is full,
  // untruncated FR text; subject_heading is hard-truncated to 65 chars at
  // ingest (confirmed by direct query) so it only catches a model name
  // that happens to land in the title's first ~65 characters -- still
  // strictly better than no check at all, which is what this used to fall
  // straight through to.
  const adFallbackText = normalizeDesignator(ad.applicability ?? ad.subject_heading ?? '')
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
    const makeMatches = adMake.includes(userMake) || userMake.includes(adMake)
    // Real AD applicability text is written against the FAA type
    // designator ("PA-28-181", "LA-4-200"), not the marketing name a pilot
    // knows their plane by ("Warrior", "Buccaneer") -- a saved model of
    // "Buccaneer" would never substring-match an AD's "LA-4" model text.
    // type_designator (src/lib/aircraftModels.ts's alias bridge, entered
    // via My Aircraft) is an alternate value to check for the same AD; a
    // match on EITHER the marketing model or the type designator counts.
    const userType = stripCessnaPrefix(userMake, normalizeDesignator(a.type_designator ?? ''))
    const userModel = stripCessnaPrefix(userMake, normalizeDesignator(a.model))
    // REVISED 2026-08-14 (RC, live Cirrus SR22 test aircraft, cross-ref
    // against backfill_aircraft_ad_notifications() finding the identical
    // shape of bug in the SQL RPC -- see
    // sync/migrations_fix_ad_model_exclusivity.sql for the full story and
    // the corpus-wide scope of affected rows). `if (adModel) {...} else if
    // (adFallbackText) {...}` treated a populated model as fully
    // exclusive of the fallback text -- so a garbled/incomplete model
    // value (e.g. a real one found live: "and serial number", an
    // extraction fragment) both fails its own match AND blocks the
    // correct, complete applicability text sitting right next to it from
    // ever being checked. Model match and fallback-text match are now
    // independent OR conditions, not either/or -- every match that worked
    // before still works (Case 1's own condition is unchanged), this only
    // adds matches a populated-but-unhelpful model was silently blocking.
    const modelMatches = adModel && (adModel.includes(userModel) || (userType && adModel.includes(userType)))
    const fallbackMatches = adFallbackText && (adFallbackText.includes(userModel) || (userType && adFallbackText.includes(userType)))
    // genuinely no model text ANYWHERE on this AD -- true last resort,
    // make-only match (the original behavior, now scoped to only the rows
    // that actually need it).
    const hasAnyModelText = Boolean(adModel || adFallbackText)

    // DESIGNATOR-ONLY ESCAPE, added 2026-09-03 after an overnight audit proved
    // the make gate was silently dropping REAL, APPLICABLE ADs -- the single
    // worst failure this app can have.
    //
    // An AD's `make` is the TYPE-CERTIFICATE HOLDER or the APPLIANCE
    // MANUFACTURER, very often a different company from the name on the
    // airframe. The make gate then rejected the AD before its applicability
    // text -- which names the aircraft explicitly -- was ever read. Measured
    // live against the real saved aircraft:
    //   LAKE Buccaneer 200EP (LA-4-200): 6 ADs name "LA-4-200", only 2 got
    //     through; the dropped ones are filed under "Revo, Incorporated",
    //     which holds the Lake type certificate.
    //   Cessna 172S: 16 ADs name "172S", 3 dropped -- including AD 2018-02-04,
    //     the Aerospace Welding muffler AD this script's own header cites as
    //     the motivating example for the whole parts feature. Its
    //     applicability literally reads "installed on but not limited to"
    //     172S airframes.
    //
    // A hit on the aircraft's own FAA type designator inside the AD's model or
    // applicability text is specific enough to stand WITHOUT the make gate.
    // The >= 4 normalized-character floor keeps it specific, and is measured,
    // not guessed:
    //   "172s"   (4) -> 17 ADs corpus-wide
    //   "la4200" (6) ->  6 ADs
    //   "172"    (3) -> 163 ADs   <-- why the floor exists
    // The marketing model ("Skyhawk", "Buccaneer") deliberately does NOT get
    // this escape; it is not specific enough to carry a match on its own.
    const DESIGNATOR_ONLY_MIN = 4
    const designatorHit =
      userType.length >= DESIGNATOR_ONLY_MIN &&
      Boolean((adModel && adModel.includes(userType)) || (adFallbackText && adFallbackText.includes(userType)))

    if (!makeMatches && !designatorHit) continue
    if (hasAnyModelText && !modelMatches && !fallbackMatches) continue
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
// work for a user with no registered push token, and what gives this run a
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

// Group by user for the push step (one notification per user combining
// every aircraft/AD match relevant to them this run), but keep the
// per-match keys so a delivery result can be written back to the specific
// log rows below. The recipient set per match is the aircraft's owner
// PLUS every active collaborator on that specific aircraft -- never
// collaborators of some OTHER aircraft that happened to match a different
// AD in this same run, since collaboratorsByAircraftId is looked up by
// this exact match's own userAircraftId.
// AD PUSH is a Premium-only capability. RC, 2026-08-05: "Pro would have to
// open the app and check their My Aircraft page to see the status of ADs.
// Their Reminders can push, b/c that's their own schedule making
// essentially... AD alerts are only pushed to Prem." Crucially this gates
// only the push -- every match was already written to
// user_ad_notifications above, unconditionally, which is exactly what
// makes the in-app status a Pro user opens the app to check real and
// current. Sharing is Premium in both directions too, so the same test
// covers collaborators.
const matchKeysByUser = new Map()
for (const [key, m] of matches) {
  const collaborators = collaboratorsByAircraftId.get(m.userAircraftId) ?? []
  const recipients = new Set(
    [m.userId, ...collaborators].filter((uid) => canReceiveAdPush(entByUser.get(uid))),
  )
  for (const recipientId of recipients) {
    if (!tokensByUser.has(recipientId)) continue // no registered device, nothing to push
    if (!matchKeysByUser.has(recipientId)) matchKeysByUser.set(recipientId, [])
    matchKeysByUser.get(recipientId).push(key)
  }
}

if (matchKeysByUser.size === 0) {
  console.log('No matched user is Premium with a registered push token — in-app AD markers written, nothing to push.')
  process.exit(0)
}

console.log(`Sending targeted AD alerts to ${matchKeysByUser.size} user(s)...`)

const messages = []
for (const [userId, keys] of matchKeysByUser) {
  const uniqueAds = [...new Map(keys.map((k) => [matches.get(k).ad.ad_number, matches.get(k).ad])).values()]
  // Which of this user's aircraft actually got a new AD this run -- lets a
  // tap land on the one specific aircraft when there's only one, matching
  // the "land directly on the thing, not a list" fix already applied to
  // collaboration invites (2026-08-29). Falls back to the Fleet list itself
  // when more than one aircraft is affected in the same push.
  const uniqueAircraftIds = [...new Set(keys.map((k) => matches.get(k).userAircraftId))]
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
      // type/userAircraftId: found in tonight's "built but inert" sweep --
      // this payload had no `type` field at all, so _layout.tsx's tap
      // handler fell through every branch and did nothing beyond opening
      // the app wherever it last was. Same gap existed for AC Update
      // Alerts and Reminder Alerts (all three now fixed together).
      data: {
        type: 'ad_alert',
        adNumbers: uniqueAds.map((a) => a.ad_number),
        userAircraftId: uniqueAircraftIds.length === 1 ? uniqueAircraftIds[0] : undefined,
      },
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

// Fold delivery results back into the durable log so "was this aircraft's
// team actually notified" has a real answer after the fact, not just a CI
// log line. user_ad_notifications is one row per (aircraft, AD) — not one
// per recipient — so with a shared aircraft now pushing to several people,
// this first collapses each match key's outcome across every recipient it
// went to (matching the exact same "upgrade to sent on any ok" shape
// already used one level up for a single user's several devices), THEN
// writes exactly one row per key. Writing more than one row per key in the
// same batch would hit the same (user_aircraft_id, ad_number) conflict
// target twice and error ("ON CONFLICT DO UPDATE command cannot affect row
// a second time"). Runs even if some rows above failed to write -- an
// upsert with ignoreDuplicates:false here so an existing row's push fields
// DO get filled in (unlike the log-write step above, which must NOT
// clobber an already-read notification's state).
const pushResultByMatchKey = new Map()
for (const [recipientId, keys] of matchKeysByUser) {
  const result = pushResultByUser.get(recipientId)
  if (!result) continue
  for (const key of keys) {
    const prev = pushResultByMatchKey.get(key)
    if (result.status === 'sent' || !prev || prev.status !== 'sent') {
      pushResultByMatchKey.set(key, result)
    }
  }
}
const updateRows = [...pushResultByMatchKey].map(([key, result]) => {
  const m = matches.get(key)
  return {
    user_id: m.userId,
    user_aircraft_id: m.userAircraftId,
    ad_number: m.ad.ad_number,
    matched_via: m.matchedVia,
    push_status: result.status,
    push_error: result.error,
    push_sent_at: new Date().toISOString(),
  }
})
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
