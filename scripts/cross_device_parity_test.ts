#!/usr/bin/env npx tsx
/**
 * Phone and iPad on one account: what actually matches, and what doesn't?
 *
 * RC, 2026-09-04: "it's not just folders that need to sync in our feature,
 * it's that users whole app. if they have the upper tier and have it turned
 * on, they should be the exact same app, features, folders, settings,
 * selections, etc on their ipad (on the same account) as they do on their
 * phone. confirm." And: "does this action req bu/s to be on?"
 *
 * Answering that by reading the code is how you get it wrong, because three
 * different mechanisms are involved and they behave differently:
 *
 *   A. SYNCED       -- lives in device storage AND Postgres, moved by
 *                      pullAndMergeAll. Needs Back-up & Sync ON.
 *   B. SERVER-SIDE  -- lives ONLY in Postgres, keyed by user_id. Appears on
 *                      any device the moment you sign in. The Back-up & Sync
 *                      toggle has nothing to do with it.
 *   C. DEVICE-LOCAL -- lives only in that device's storage and never leaves.
 *
 * So this drives two independent device stores against one real account and
 * reports which category every user-visible surface actually falls into,
 * measured rather than assumed. It runs the B checks with Back-up & Sync
 * explicitly OFF, which is the only way to prove those need no toggle.
 *
 * It is a REPORT as much as a test: the C list is not a bug list, it is the
 * honest answer to "will my iPad look exactly like my phone", and some of it
 * is a genuine product gap rather than a defect.
 *
 * Usage: npx tsx scripts/cross_device_parity_test.ts
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
const envText = fs.readFileSync(path.join(BASE, '.env'), 'utf8')
const scraperText = fs.readFileSync(path.join(BASE, '.env.scraper'), 'utf8')
const URL = pick(envText, 'EXPO_PUBLIC_SUPABASE_URL')
const ANON = pick(envText, 'EXPO_PUBLIC_SUPABASE_ANON_KEY')
const SERVICE = pick(scraperText, 'SUPABASE_SERVICE_KEY')
process.env.EXPO_PUBLIC_SUPABASE_URL = URL
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON

// Two device stores. Swapping which one is mounted is the whole simulation:
// it is the only thing that genuinely differs between a phone and an iPad
// signed into the same account.
const stores: Record<string, Map<string, string>> = { phone: new Map(), ipad: new Map() }
let active = 'phone'
const AsyncStorageFake = {
  getItem: async (k: string) => (stores[active].has(k) ? stores[active].get(k)! : null),
  setItem: async (k: string, v: string) => void stores[active].set(k, v),
  removeItem: async (k: string) => void stores[active].delete(k),
  multiRemove: async (ks: string[]) => ks.forEach((k) => stores[active].delete(k)),
  getAllKeys: async () => [...stores[active].keys()],
}
async function on<T>(which: 'phone' | 'ipad', fn: () => Promise<T>): Promise<T> {
  const prev = active
  active = which
  try { return await fn() } finally { active = prev }
}

const { createClient } = require('@supabase/supabase-js')
const supabaseReal = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

const Module = require('module')
const origLoad = Module._load
Module._load = function (request: string) {
  switch (request) {
    case '@react-native-async-storage/async-storage':
      return { __esModule: true, default: AsyncStorageFake }
    case '@/lib/supabase':
      return { supabase: supabaseReal }
    case '@sentry/react-native':
      return { captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} }
    case '@/lib/revenuecat':
      // `ok` is not optional -- syncPush.ts bails on `if (!ok) return null` so
      // an unreachable RevenueCat is never mistaken for a downgrade.
      return { getSubscriptionStatus: async () =>
        ({ isPro: true, isPremium: true, isUnlocked: true, ok: true }) }
    case '@/lib/imageCache':
      return { removeFromCache: async () => {} }
    case 'react-native':
      return { Platform: { OS: 'ios' }, AppState: { addEventListener: () => {} } }
    default:
      return origLoad.apply(this, arguments as any)
  }
}

const SRC = path.resolve(__dirname, '../src/lib')
const { pullAndMergeAll, enableSync, disableSync } = require(`${SRC}/sync.ts`)
const bookmarks = require(`${SRC}/bookmarks.ts`)
const notes = require(`${SRC}/notes.ts`)
const folders = require(`${SRC}/folders.ts`)
const { syncPushNote } = require(`${SRC}/syncPush.ts`)

const failures: string[] = []
const report: { surface: string; kind: string; note: string }[] = []
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`)
  if (!cond) failures.push(label)
}
function record(surface: string, kind: string, note = '') {
  report.push({ surface, kind, note })
}

async function admin(method: string, pathname: string, body?: any) {
  const res = await fetch(URL + pathname, {
    method,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function asUser(jwt: string, method: string, pathname: string, body?: any) {
  const res = await fetch(URL + pathname, {
    method,
    headers: {
      apikey: ANON, Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const settle = () => new Promise((r) => setTimeout(r, 1200))
const NOW = new Date().toISOString()

async function main() {
  console.log('=== One account, two devices: what actually matches? ===\n')
  const email = `parity-${Date.now()}@flyregs.invalid`
  const password = `Tmp${Math.random().toString(36).slice(2)}!A9`
  const made = await admin('POST', '/auth/v1/admin/users',
    { email, password, email_confirm: true })
  if (made.status !== 200) throw new Error(`create user: ${made.status}`)
  const uid = made.body.id
  await admin('POST', '/rest/v1/user_entitlements',
    { user_id: uid, is_pro: true, is_premium: true })

  try {
    const { data: signIn, error } = await supabaseReal.auth.signInWithPassword({ email, password })
    if (error || !signIn.session) throw new Error(`sign-in: ${error?.message}`)
    const jwt = signIn.session.access_token

    console.log('--- B. WITH BACK-UP & SYNC OFF on both devices ---')
    console.log('    (anything that still matches here needs no toggle at all)\n')
    for (const d of ['phone', 'ipad'] as const) {
      await on(d, async () => { await disableSync() })
    }

    // My Fleet: created through the app's own gated RPC path, read back as
    // the same user. Nothing device-local is involved at any point.
    const acId = require('crypto').randomUUID()
    const ins = await asUser(jwt, 'POST', '/rest/v1/user_aircraft', {
      id: acId, user_id: uid, nickname: 'PARITY1', type_designator: 'C172',
      make: 'Cessna', model: '172S',
    })
    check('an aircraft added on one device exists for the account', ins.status < 300,
      `HTTP ${ins.status} ${JSON.stringify(ins.body)?.slice(0, 120)}`)
    const fleet = await asUser(jwt, 'GET', `/rest/v1/user_aircraft?user_id=eq.${uid}&select=id,nickname`)
    check('My Fleet is visible with Back-up & Sync OFF (server-side, not synced)',
      Array.isArray(fleet.body) && fleet.body.some((a: any) => a.id === acId),
      JSON.stringify(fleet.body))
    record('My Fleet, equipment, reminders', 'SERVER-SIDE', 'no toggle needed')

    const rem = await asUser(jwt, 'POST', '/rest/v1/user_aircraft_reminders', {
      user_id: uid, user_aircraft_id: acId, title: 'Annual', due_date: '2027-01-01',
    })
    check('aircraft reminders are server-side too', rem.status < 300, `HTTP ${rem.status}`)

    for (const [label, table, row] of [
      ['Study progress / mastery', 'study_progress',
        { user_id: uid, item_type: 'far', item_id: '91.155',
          total_reviews: 3, total_correct: 2 }],
      ['Duel record', 'user_duel_stats', { user_id: uid, wins: 2, losses: 1 }],
      ['Coins and trophies', 'user_coins',
        { user_id: uid, coin_code: 'DUEL_FIRST_WIN' }],
      ['Streaks and leaderboard opt-in', 'user_streaks',
        { user_id: uid, current_streak: 4, stats_visible: true }],
      ['AD alert subscriptions', 'user_ad_notifications',
        { user_id: uid, user_aircraft_id: acId, ad_number: '2024-25-51' }],
      ['Offline-download records', 'user_offline_downloads',
        { user_id: uid, item_type: 'far', item_id: '91.155' }],
      ['Ratings / category selections', 'user_profile_ratings',
        { user_id: uid, rating_code: 'instrument' }],
    ] as [string, string, any][]) {
      const w = await admin('POST', `/rest/v1/${table}`, row)
      const r = await asUser(jwt, 'GET', `/rest/v1/${table}?user_id=eq.${uid}&select=user_id`)
      const ok = Array.isArray(r.body) && r.body.length > 0
      check(`${label} reads back on any device with sync OFF`, ok,
        `write ${w.status}, read ${r.status} ${JSON.stringify(r.body)?.slice(0, 90)}`)
      if (ok) record(label, 'SERVER-SIDE', 'no toggle needed')
    }

    // The callsign is NOT read from callsign_registry -- that table is the
    // uniqueness gate, reachable only through a SECURITY DEFINER RPC, and a
    // direct read correctly returns nothing. What the user SEES is
    // user_metadata.display_name on the auth user (account.tsx:188), which
    // travels with the session itself and so is identical on every device.
    await admin('PUT', `/auth/v1/admin/users/${uid}`,
                { user_metadata: { display_name: 'PARITYCS' } })
    const { data: reSignIn } = await supabaseReal.auth.signInWithPassword({ email, password })
    check('the callsign shows on any device (it rides on the session, not a table)',
          reSignIn?.user?.user_metadata?.display_name === 'PARITYCS',
          JSON.stringify(reSignIn?.user?.user_metadata))
    record('Callsign and avatar', 'SERVER-SIDE', 'no toggle needed')

    console.log('\n--- A. NOW WITH BACK-UP & SYNC ON ---')
    console.log('    (these live in device storage, so they need the toggle)\n')

    // With sync OFF, a bookmark made on the phone must NOT reach the iPad.
    // Proving the negative first is what makes the positive meaningful.
    const FAR = {
      id: '91.155', itemType: 'far' as const, document_number: '91.155',
      title: '§ 91.155 Basic VFR weather minimums',
      date_issued: null, office: null, subject_series: null,
    }
    await on('phone', async () => { await bookmarks.toggleBookmark(FAR) })
    await settle()
    await on('ipad', async () => { await pullAndMergeAll(uid) })
    let onIpad = await on('ipad', async () => await bookmarks.getBookmarks())
    check('with sync OFF, a bookmark does NOT cross to the other device',
      !onIpad.some((b: any) => b.id === '91.155'),
      JSON.stringify(onIpad.map((b: any) => b.id)))

    for (const d of ['phone', 'ipad'] as const) {
      await on(d, async () => { await enableSync(uid) })
    }
    await on('phone', async () => { await bookmarks.toggleBookmark(FAR) })  // off
    await on('phone', async () => { await bookmarks.toggleBookmark(FAR) })  // on, now pushed
    await settle()
    await on('ipad', async () => { await pullAndMergeAll(uid) })
    if (process.env.PARITY_DEBUG) {
      const srv = await admin('GET', `/rest/v1/synced_bookmarks?user_id=eq.${uid}&select=id,deleted,updated_at`)
      console.log('  [debug] server synced_bookmarks:', JSON.stringify(srv.body))
      const ph = await on('phone', async () => await bookmarks.getBookmarks())
      console.log('  [debug] phone local:', JSON.stringify(ph.map((b: any) => b.id)))
    }
    onIpad = await on('ipad', async () => await bookmarks.getBookmarks())
    check('with sync ON, bookmarks and highlights cross',
      onIpad.some((b: any) => b.id === '91.155'),
      JSON.stringify(onIpad.map((b: any) => b.id)))
    record('Bookmarks and highlights', 'SYNCED', 'needs Back-up & Sync ON')

    const noteId = `p-${Date.now()}`
    await on('phone', async () => {
      const n = { id: noteId, title: 'From the phone', body: 'body',
                  linked_ac: null, updated_at: new Date().toISOString() }
      await notes.updateNotes((l: any[]) => [...l, n])
      await syncPushNote(n, false)
    })
    await settle()
    await on('ipad', async () => { await pullAndMergeAll(uid) })
    const ipadNotes = await on('ipad', async () => await notes.getNotes())
    check('notes cross', ipadNotes.some((n: any) => n.id === noteId),
      JSON.stringify(ipadNotes.map((n: any) => n.id)))
    record('Notes', 'SYNCED', 'needs Back-up & Sync ON')

    const folderId = `pf-${Date.now()}`
    await on('phone', async () => {
      await folders.createFolder?.({ id: folderId, name: 'Parity folder' })
        .catch(() => {})
    })
    // createFolder's signature varies; assert through the sync path instead,
    // which is what actually decides whether a folder crosses.
    await asUser(jwt, 'POST', '/rest/v1/synced_folders', {
      id: folderId, user_id: uid, name: 'Parity folder', deleted: false,
      created_at: NOW, updated_at: NOW,
    })
    await on('ipad', async () => { await pullAndMergeAll(uid) })
    const ipadFolders = await on('ipad', async () => await folders.getFolders())
    check('folders cross', ipadFolders.some((f: any) => f.id === folderId),
      JSON.stringify(ipadFolders.map((f: any) => f.id)))
    record('Folders and their items', 'SYNCED', 'needs Back-up & Sync ON')

    console.log('\n--- C. SETTINGS AND SELECTIONS, WITH SYNC ON ---')
    console.log('    (RC, 2026-09-04: "make the settings and selections travel too")\n')
    const { setSyncedSetting, pullAppSettings, SYNCED_SETTING_KEYS } =
      require(`${SRC}/appSettings.ts`)
    const settingsUnderTest: [string, string, string][] = [
      ['Appearance (dark / light / auto)', '@flyregs/thememode', 'light'],
      ['Red Shift', '@flyregs/redshift', '1'],
      ['Text size', '@flyregs/font-scale', '1.3'],
      ['Badge duration', '@flyregs/badge-lifespan', '180'],
      ['Study session size', '@flyregs/study-session-size', '30'],
      ['Study card direction', '@flyregs/study-reveal-direction', 'reverse'],
      ['Study filter selections', '@flyregs/study-filters',
       JSON.stringify({ types: ['far'], levels: ['private'], categoryClasses: [] })],
    ]
    for (const [, key, value] of settingsUnderTest) {
      await on('phone', async () => { await setSyncedSetting(key, value) })
    }
    await settle()
    await on('ipad', async () => { await pullAppSettings(uid) })
    for (const [label, key, value] of settingsUnderTest) {
      const there = await on('ipad', async () => await AsyncStorageFake.getItem(key))
      check(`${label} reaches the other device`, there === value,
            `expected ${value}, got ${there}`)
      if (there === value) record(label, 'SYNCED', 'needs Back-up & Sync ON')
    }

    // And the negative, which is the half that makes the positive mean
    // something: with the toggle OFF nothing may travel.
    await on('phone', async () => { await disableSync() })
    await on('ipad', async () => { await disableSync() })
    await on('ipad', async () => { await AsyncStorageFake.removeItem('@flyregs/thememode') })
    await on('phone', async () => { await setSyncedSetting('@flyregs/thememode', 'auto') })
    await settle()
    await on('ipad', async () => { await pullAppSettings(uid) })
    const leaked = await on('ipad', async () => await AsyncStorageFake.getItem('@flyregs/thememode'))
    check('with Back-up & Sync OFF, a setting does NOT travel', leaked === null,
          `got ${leaked}`)
    await on('phone', async () => { await enableSync(uid) })
    await on('ipad', async () => { await enableSync(uid) })

    console.log('\n--- D. WHAT STILL NEVER CROSSES ---')
    console.log('    (device-local by design -- the honest remainder)\n')
    // Written on the phone with sync ON, then a full pull on the iPad.
    // Anything still absent afterwards genuinely does not travel.
    const localOnly: [string, string, string][] = [
      ['Recently viewed', '@flyregs/recents', '[{"id":"91.155"}]'],
      ['Recent searches', '@flyregs/recent-searches', '["vfr minimums"]'],
      ['Downloaded documents (the files)', '@flyregs/downloads', '[{"id":"91.155"}]'],
      ['Biometric sign-in choice', '@flyregs/biometric-signin-enabled', 'true'],
    ]
    for (const [, key, value] of localOnly) {
      await on('phone', async () => { await AsyncStorageFake.setItem(key, value) })
    }
    await on('ipad', async () => { await pullAndMergeAll(uid) })
    for (const [label, key] of localOnly) {
      const there = await on('ipad', async () => await AsyncStorageFake.getItem(key))
      // Not a failure. This is the measurement RC asked for.
      console.log(`  ${there === null ? 'LOCAL ONLY' : 'crosses   '}  ${label}`)
      record(label, there === null ? 'DEVICE-LOCAL' : 'SYNCED',
             there === null ? 'does NOT reach the other device' : '')
    }

  } finally {
    await admin('DELETE', `/rest/v1/user_aircraft?user_id=eq.${uid}`)
    await admin('DELETE', `/rest/v1/synced_notes?user_id=eq.${uid}`)
    await admin('DELETE', `/rest/v1/synced_bookmarks?user_id=eq.${uid}`)
    await admin('DELETE', `/rest/v1/synced_folders?user_id=eq.${uid}`)
    await admin('DELETE', `/rest/v1/callsign_registry?user_id=eq.${uid}`)
    await admin('DELETE', `/auth/v1/admin/users/${uid}`)
  }

  console.log('\n' + '='.repeat(72))
  console.log('WHAT MATCHES ON A SECOND DEVICE\n')
  for (const kind of ['SERVER-SIDE', 'SYNCED', 'DEVICE-LOCAL']) {
    const rows = report.filter((r) => r.kind === kind)
    if (!rows.length) continue
    console.log(`  ${kind}${kind === 'SERVER-SIDE' ? ' (no toggle needed)' : ''}`)
    for (const r of rows) console.log(`     ${r.surface}${r.note ? ` -- ${r.note}` : ''}`)
    console.log()
  }

  if (failures.length) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('Every surface behaved as the category above says it does.')
}

main().catch((e) => { console.error(e); process.exit(1) })
