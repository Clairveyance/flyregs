// Sends "AC Update Alerts" push notifications (Premium feature) for whatever
// ACs the current sync run actually touched.
//
// Run from the ac-app/ directory, after backfill-blocks.mjs has produced its
// --touched-out file for this run:
//   node scripts/send-update-alerts.mjs --touched-file=<path>
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper (bypasses
// RLS, needed to read every enabled push_tokens row across all users). Keys
// are never printed. If the touched-file is missing/empty, this is a no-op —
// a normal weekly run with no content changes sends nothing.
//
// Requires migrations/add_push_tokens.sql to have been run first.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

// ── Load credentials (never logged) ─────────────────────────────────────────
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

const touchedDocs = fs
  .readFileSync(touchedFilePath, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

if (touchedDocs.length === 0) {
  console.log('Touched-file is empty — no ACs changed this run, nothing to notify.')
  process.exit(0)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── Look up titles for the notification body ────────────────────────────────
const { data: acs, error: acErr } = await sb
  .from('advisory_circulars')
  .select('document_number,title')
  .in('document_number', touchedDocs)

if (acErr) {
  console.error('Failed to fetch touched AC titles:', acErr.message)
  process.exit(1)
}

const title =
  touchedDocs.length === 1
    ? `AC ${touchedDocs[0]} updated`
    : `${touchedDocs.length} Advisory Circulars updated`
const body =
  touchedDocs.length === 1
    ? (acs?.[0]?.title ?? 'Tap to view the latest version.')
    : touchedDocs.slice(0, 3).map((d) => `AC ${d}`).join(', ') + (touchedDocs.length > 3 ? ', and more' : '')

// ── Fetch enabled recipients ─────────────────────────────────────────────────
const { data: tokens, error: tokenErr } = await sb
  .from('push_tokens')
  .select('expo_push_token')
  .eq('enabled', true)

if (tokenErr) {
  console.error('Failed to fetch push tokens:', tokenErr.message)
  process.exit(1)
}

if (!tokens || tokens.length === 0) {
  console.log('No enabled push tokens — nothing to send.')
  process.exit(0)
}

console.log(`Sending update alert to ${tokens.length} device(s) for: ${touchedDocs.join(', ')}`)

// ── Send via Expo's Push API (batches of 100 per their limit) ───────────────
const messages = tokens.map((t) => ({
  to: t.expo_push_token,
  sound: 'default',
  title,
  body,
  data: { documentNumbers: touchedDocs },
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
