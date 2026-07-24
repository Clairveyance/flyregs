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
  .select('ad_number, subject_heading, make, model')
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
const [{ data: aircraft, error: acErr }, { data: tokens, error: tokErr }] = await Promise.all([
  sb.from('user_aircraft').select('user_id, make, model'),
  sb.from('push_tokens').select('user_id, expo_push_token').eq('enabled', true),
])
if (acErr) {
  console.error('Failed to fetch user_aircraft:', acErr.message)
  process.exit(1)
}
if (tokErr) {
  console.error('Failed to fetch push_tokens:', tokErr.message)
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

// user_id -> matching ADs
const matchesByUser = new Map()
for (const ad of ads) {
  if (!ad.make) continue
  const adMake = ad.make.trim().toLowerCase()
  const adModel = (ad.model ?? '').toLowerCase()
  for (const a of aircraft) {
    if (!tokensByUser.has(a.user_id)) continue // no enabled device, nothing to send
    if (a.make.trim().toLowerCase() !== adMake) continue
    // If an AD's own model field is null (the scraper's model-extraction
    // regex doesn't catch every Applicability paragraph shape), match on
    // MAKE alone rather than silently excluding it — an occasional extra
    // notification is a much smaller cost than missing a real applicable
    // AD, which is exactly the failure mode this whole feature exists to
    // prevent.
    if (adModel && !adModel.includes(a.model.trim().toLowerCase())) continue
    if (!matchesByUser.has(a.user_id)) matchesByUser.set(a.user_id, [])
    matchesByUser.get(a.user_id).push(ad)
  }
}

if (matchesByUser.size === 0) {
  console.log(`${ads.length} AD(s) touched this run, but none matched any saved aircraft — nothing to notify.`)
  process.exit(0)
}

console.log(`Sending targeted AD alerts to ${matchesByUser.size} user(s)...`)

const messages = []
for (const [userId, matchedAds] of matchesByUser) {
  const uniqueAds = [...new Map(matchedAds.map((a) => [a.ad_number, a])).values()]
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
    })
  }
}

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
