#!/usr/bin/env npx tsx
/**
 * Two devices, both with their own data, sync switched on for the first time.
 * Who wins, and does anything get erased?
 *
 * RC, 2026-09-04: "scenario: user has bu/s off. they have two devices, both
 * running same account. they turn on bu/s > which device's info syncs to
 * which? if they have other things on the other device, do those get
 * over-written/erased during the sync. need to decide how to handle this and
 * how to inform users."
 *
 * This is the one moment where the two devices genuinely disagree and nothing
 * has ever reconciled them. Every other sync question has an obvious answer
 * (the newer change wins); this one does not, because before the first sync
 * neither device's data has ever been compared to the other's.
 *
 * There are two different answers, and conflating them is how this gets got
 * wrong:
 *
 *   CONTENT -- bookmarks, folders, folder items, notes -- is keyed by id and
 *   MERGED. Two devices with different bookmarks end up with the union, and
 *   nothing is erased. That is what the merge functions are for.
 *
 *   SETTINGS are single-valued. There is no union of "dark" and "light". One
 *   of them has to win, and which one is a product decision, not a technical
 *   one.
 *
 * So this measures both, separately, with two device stores that have never
 * seen each other.
 *
 * Usage: npx tsx scripts/first_sync_conflict_test.ts
 */
declare const __dirname: string
declare const process: any
declare const require: any

const fs = require('fs')
const path = require('path')
const BASE = path.resolve(__dirname, '..')
const pick = (text: string, key: string) => {
  const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${key}=(.+)$`, 'm'))
  if (!m) throw new Error(`${key} not found`)
  return m[1].trim()
}
const URL = pick(fs.readFileSync(path.join(BASE, '.env'), 'utf8'), 'EXPO_PUBLIC_SUPABASE_URL')
const ANON = pick(fs.readFileSync(path.join(BASE, '.env'), 'utf8'), 'EXPO_PUBLIC_SUPABASE_ANON_KEY')
const SERVICE = pick(fs.readFileSync(path.join(BASE, '.env.scraper'), 'utf8'), 'SUPABASE_SERVICE_KEY')
process.env.EXPO_PUBLIC_SUPABASE_URL = URL
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON

const stores: Record<string, Map<string, string>> = { phone: new Map(), ipad: new Map() }
let active = 'phone'
const AS = {
  getItem: async (k: string) => (stores[active].has(k) ? stores[active].get(k)! : null),
  setItem: async (k: string, v: string) => void stores[active].set(k, v),
  removeItem: async (k: string) => void stores[active].delete(k),
  multiRemove: async (ks: string[]) => ks.forEach((k) => stores[active].delete(k)),
  getAllKeys: async () => [...stores[active].keys()],
}
async function on<T>(w: 'phone' | 'ipad', fn: () => Promise<T>): Promise<T> {
  const prev = active; active = w
  try { return await fn() } finally { active = prev }
}

const { createClient } = require('@supabase/supabase-js')
const supabaseReal = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const Module = require('module'); const origLoad = Module._load
Module._load = function (r: string) {
  switch (r) {
    case '@react-native-async-storage/async-storage': return { __esModule: true, default: AS }
    case '@/lib/supabase': return { supabase: supabaseReal }
    case '@sentry/react-native': return { captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} }
    case '@/lib/revenuecat': return { getSubscriptionStatus: async () => ({ isPro: true, isPremium: true, isUnlocked: true, ok: true }) }
    case '@/lib/imageCache': return { removeFromCache: async () => {} }
    case 'react-native': return { Platform: { OS: 'ios' }, AppState: { addEventListener: () => {} } }
    default: return origLoad.apply(this, arguments as any)
  }
}
const SRC = path.resolve(__dirname, '../src/lib')
const { enableSync, disableSync, pullAndMergeAll } = require(`${SRC}/sync.ts`)
const bookmarks = require(`${SRC}/bookmarks.ts`)
const notes = require(`${SRC}/notes.ts`)
const { syncPushNote } = require(`${SRC}/syncPush.ts`)
const { setSyncedSetting } = require(`${SRC}/appSettings.ts`)

const failures: string[] = []
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`)
  if (!cond) failures.push(label)
}
async function admin(method: string, p: string, body?: any) {
  const res = await fetch(URL + p, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
               'Content-Type': 'application/json',
               Prefer: 'resolution=merge-duplicates,return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await res.text()
  return { status: res.status, body: t ? JSON.parse(t) : null }
}
const settle = () => new Promise((r) => setTimeout(r, 1400))
const bm = (id: string) => ({
  id, itemType: 'far' as const, document_number: id, title: `§ ${id}`,
  date_issued: null, office: null, subject_series: null,
})

async function main() {
  console.log('=== First sync, two devices that have never met ===\n')
  const email = `firstsync-${Date.now()}@flyregs.invalid`
  const password = `Tmp${Math.random().toString(36).slice(2)}!A9`
  const made = await admin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true })
  const uid = made.body.id
  await admin('POST', '/rest/v1/user_entitlements', { user_id: uid, is_pro: true, is_premium: true })

  try {
    const { data: si } = await supabaseReal.auth.signInWithPassword({ email, password })
    if (!si?.session) throw new Error('sign-in failed')

    // Both devices start with sync OFF and their own separate history.
    for (const d of ['phone', 'ipad'] as const) await on(d, async () => { await disableSync() })

    await on('phone', async () => {
      await bookmarks.toggleBookmark(bm('91.155'))
      await notes.updateNotes((l: any[]) => [...l, {
        id: 'note-phone', title: 'Phone note', body: 'written on the phone',
        linked_ac: null, updated_at: new Date().toISOString() }])
      await AS.setItem('@flyregs/thememode', 'light')
      await AS.setItem('@flyregs/badge-lifespan', '180')
      await AS.setItem('@flyregs/redshift', '1')
    })
    await on('ipad', async () => {
      await bookmarks.toggleBookmark(bm('91.157'))
      await notes.updateNotes((l: any[]) => [...l, {
        id: 'note-ipad', title: 'iPad note', body: 'written on the iPad',
        linked_ac: null, updated_at: new Date().toISOString() }])
      await AS.setItem('@flyregs/thememode', 'dark')
      await AS.setItem('@flyregs/badge-lifespan', '14')
    })
    console.log('  phone: bookmark 91.155, one note, Light + 180-day badges + Red Shift on')
    console.log('  ipad : bookmark 91.157, one note, Dark  +  14-day badges\n')

    console.log('--- 1. PHONE turns Back up & sync on first ---')
    await on('phone', async () => { await enableSync(uid) })
    await settle()
    const srvSettings1 = await admin('GET', `/rest/v1/user_app_settings?user_id=eq.${uid}&select=key,value`)
    const asMap = (b: any) => Object.fromEntries((b || []).map((r: any) => [r.key, r.value]))
    let srv = asMap(srvSettings1.body)
    check('the first device to enable seeds the account settings',
          srv['@flyregs/thememode'] === 'light' && srv['@flyregs/badge-lifespan'] === '180',
          JSON.stringify(srv))

    console.log('\n--- 2. IPAD turns it on second. Does it overwrite the phone? ---')
    await on('ipad', async () => { await enableSync(uid) })
    await settle()
    srv = asMap((await admin('GET', `/rest/v1/user_app_settings?user_id=eq.${uid}&select=key,value`)).body)
    check("the account KEEPS the first device's settings",
          srv['@flyregs/thememode'] === 'light', `theme is now ${srv['@flyregs/thememode']}`)
    check("...including ones the second device also had set differently",
          srv['@flyregs/badge-lifespan'] === '180', `badge is now ${srv['@flyregs/badge-lifespan']}`)
    const ipadTheme = await on('ipad', async () => await AS.getItem('@flyregs/thememode'))
    check('the second device ADOPTS the account settings rather than imposing its own',
          ipadTheme === 'light', `iPad theme is ${ipadTheme}`)
    const ipadRedshift = await on('ipad', async () => await AS.getItem('@flyregs/redshift'))
    check('...including a setting it never had (Red Shift came from the phone)',
          ipadRedshift === '1', `iPad redshift is ${ipadRedshift}`)

    console.log('\n--- 3. CONTENT: is anything erased? ---')
    // The question RC actually asked. Content is keyed by id and merged, so
    // two devices with different bookmarks should end up with BOTH.
    await on('phone', async () => { await pullAndMergeAll(uid) })
    const phoneBm = (await on('phone', async () => await bookmarks.getBookmarks())).map((b: any) => b.id)
    const ipadBm = (await on('ipad', async () => await bookmarks.getBookmarks())).map((b: any) => b.id)
    check('the phone KEPT its own bookmark', phoneBm.includes('91.155'), String(phoneBm))
    check("the phone GAINED the iPad's bookmark", phoneBm.includes('91.157'), String(phoneBm))
    check('the iPad KEPT its own bookmark', ipadBm.includes('91.157'), String(ipadBm))
    check("the iPad GAINED the phone's bookmark", ipadBm.includes('91.155'), String(ipadBm))

    const phoneNotes = (await on('phone', async () => await notes.getNotes())).map((n: any) => n.id)
    const ipadNotes = (await on('ipad', async () => await notes.getNotes())).map((n: any) => n.id)
    check('both notes survive on the phone',
          phoneNotes.includes('note-phone') && phoneNotes.includes('note-ipad'), String(phoneNotes))
    check('both notes survive on the iPad',
          ipadNotes.includes('note-phone') && ipadNotes.includes('note-ipad'), String(ipadNotes))

    console.log('\n--- 4. AFTER the first sync, the newest change wins ---')
    await on('ipad', async () => { await setSyncedSetting('@flyregs/thememode', 'dark') })
    await settle()
    await on('phone', async () => { await pullAndMergeAll(uid) })
    const phoneTheme = await on('phone', async () => await AS.getItem('@flyregs/thememode'))
    check('a change made on either device afterwards reaches the other',
          phoneTheme === 'dark', `phone theme is ${phoneTheme}`)

  } finally {
    for (const t of ['user_app_settings', 'synced_notes', 'synced_bookmarks', 'synced_folders']) {
      await admin('DELETE', `/rest/v1/${t}?user_id=eq.${uid}`)
    }
    await admin('DELETE', `/auth/v1/admin/users/${uid}`)
  }

  console.log()
  if (failures.length) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('First device sets the baseline, the second adopts it, and no content is lost.')
}
main().catch((e) => { console.error(e); process.exit(1) })
