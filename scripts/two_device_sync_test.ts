#!/usr/bin/env npx tsx
/**
 * Two devices, one account: does everything actually arrive on both?
 *
 * RC, 2026-09-04: "def make sure sync etc works perfectly. Robin was already
 * reporting a strong desire to be able to sync his phone and ipad. it must
 * work perfectly."
 *
 * Every existing sync test covers one side of the wire. The server tests
 * prove rows land in Postgres; sync_owner_claim_test.ts proves two specific
 * merge orderings against a fake supabase. Neither answers the question
 * Robin is actually asking, which is whether a bookmark made on the phone
 * shows up on the iPad and vice versa, repeatedly, without either device
 * destroying what the other did.
 *
 * WHAT MAKES THIS A REAL TWO-DEVICE TEST
 * --------------------------------------
 * The only thing that genuinely differs between two devices of the same
 * account is device-local storage. So: ONE real Supabase account, ONE real
 * network client, and TWO independent AsyncStorage backings that the fake
 * swaps between. `asDevice('A', ...)` runs a block with device A's storage
 * mounted; the real src/lib modules -- sync.ts, bookmarks.ts, folders.ts,
 * notes.ts, syncPush.ts, syncOwner.ts -- are loaded once and used unchanged.
 *
 * Deliberately NOT faked: Supabase. This talks to the live database over the
 * network with a real JWT, so RLS, the write path, and pullAndMergeAll's
 * paging are all exercised for real. A fake would have let every one of the
 * data-loss bugs this file is guarding against pass.
 *
 * Faked, and only these: AsyncStorage (the thing being varied), Sentry
 * (no crash reporter in a script), revenuecat (the account is granted Pro
 * directly in the database), imageCache and react-native (no native side).
 *
 * Usage: npx tsx scripts/two_device_sync_test.ts
 */
declare const __dirname: string
declare const process: any
declare const require: any

const fs = require('fs')
const path = require('path')

// ── credentials ─────────────────────────────────────────────────────────────
const BASE = path.resolve(__dirname, '..')
const envText = fs.readFileSync(path.join(BASE, '.env'), 'utf8')
const scraperText = fs.readFileSync(path.join(BASE, '.env.scraper'), 'utf8')
const pick = (text: string, key: string) => {
  const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${key}=(.+)$`, 'm'))
  if (!m) throw new Error(`${key} not found`)
  return m[1].trim()
}
const URL = pick(envText, 'EXPO_PUBLIC_SUPABASE_URL')
const ANON = pick(envText, 'EXPO_PUBLIC_SUPABASE_ANON_KEY')
const SERVICE = pick(scraperText, 'SUPABASE_SERVICE_KEY')

process.env.EXPO_PUBLIC_SUPABASE_URL = URL
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON

// ── two device-local stores, one of them mounted at a time ──────────────────
const stores: Record<string, Map<string, string>> = { A: new Map(), B: new Map() }
let active = 'A'
const AsyncStorageFake = {
  getItem: async (k: string) => (stores[active].has(k) ? stores[active].get(k)! : null),
  setItem: async (k: string, v: string) => void stores[active].set(k, v),
  removeItem: async (k: string) => void stores[active].delete(k),
  multiRemove: async (ks: string[]) => ks.forEach((k) => stores[active].delete(k)),
  getAllKeys: async () => [...stores[active].keys()],
}

async function asDevice<T>(which: 'A' | 'B', fn: () => Promise<T>): Promise<T> {
  const prev = active
  active = which
  try {
    return await fn()
  } finally {
    active = prev
  }
}

// ── module fakes, installed before the real modules load ────────────────────
const { createClient } = require('@supabase/supabase-js')
// A REAL client, built without react-native. persistSession is off because
// the session is set explicitly below -- the devices share an account, and
// letting supabase-js write its session into whichever store happens to be
// mounted would make sign-in state itself device-dependent, which is not what
// is being tested here.
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
      // `ok` is not optional. syncPush.ts's currentUserId() bails on
      // `if (!ok) return null` -- deliberately, so an unreachable
      // RevenueCat is never mistaken for a downgrade. Omitting it from
      // this stub made every push silently no-op and had this test
      // reporting that sync was completely broken. The guard was right;
      // the stub was wrong.
      return {
        getSubscriptionStatus: async () =>
          ({ isPro: true, isPremium: true, isUnlocked: true, ok: true }),
      }
    case '@/lib/imageCache':
      return { removeFromCache: async () => {} }
    case 'react-native':
      return { Platform: { OS: 'ios' }, AppState: { addEventListener: () => {} } }
    default:
      return origLoad.apply(this, arguments as any)
  }
}

const SRC = path.resolve(__dirname, '../src/lib')
const { pullAndMergeAll, enableSync } = require(`${SRC}/sync.ts`)
const bookmarks = require(`${SRC}/bookmarks.ts`)
const notes = require(`${SRC}/notes.ts`)
const folders = require(`${SRC}/folders.ts`)
const { syncPushNote, syncPushNoteDeletes } = require(`${SRC}/syncPush.ts`)

// bookmarks.ts pushes from inside addBookmark/removeBookmark, but notes do
// NOT -- notes.tsx and folder/[id].tsx call syncPushNote themselves right
// after updateNotes. This mirrors those call sites exactly rather than
// inventing a push path the app doesn't have.
async function writeNote(n: any) {
  await notes.updateNotes((l: any[]) => [...l.filter((x: any) => x.id !== n.id), n])
  await syncPushNote(n, false)
}

// Every push in the app is fire-and-forget -- deliberately, so a slow
// network never blocks a tap. A test that pulls the instant it writes is
// racing that, and would report a sync failure that a real user (who takes
// longer than 0ms to pick up the other device) would never see.
const settle = () => new Promise((r) => setTimeout(r, 1200))

// The real BookmarkAC shape, not an invented one -- itemType (not `type`)
// is what bookmarkItemType() and the push RPC both key on.
const FAR_91_155 = {
  id: '91.155',
  itemType: 'far' as const,
  document_number: '91.155',
  title: '\u00a7 91.155 Basic VFR weather minimums',
  date_issued: null,
  office: null,
  subject_series: null,
}

// ── plumbing ────────────────────────────────────────────────────────────────
const failures: string[] = []
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`)
  if (!cond) failures.push(label)
}

async function admin(method: string, pathname: string, body?: any) {
  const res = await fetch(URL + pathname, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function main() {
  console.log('=== two devices, one account: real sync over the real database ===')
  const email = `twodev-${Date.now()}@flyregs.invalid`
  const password = `Tmp${Math.random().toString(36).slice(2)}!A9`

  const made = await admin('POST', '/auth/v1/admin/users',
    { email, password, email_confirm: true })
  if (made.status !== 200) throw new Error(`could not create user: ${made.status} ${JSON.stringify(made.body)}`)
  const uid = made.body.id
  // Back up & sync is Pro-gated server-side; granted directly rather than
  // through a purchase, the same way every other test account here is.
  await admin('POST', '/rest/v1/user_entitlements', { user_id: uid, is_pro: true, is_premium: true })

  try {
    const { data: signIn, error: signInErr } =
      await supabaseReal.auth.signInWithPassword({ email, password })
    if (signInErr || !signIn.session) throw new Error(`sign-in failed: ${signInErr?.message}`)

    // Both devices are the same signed-in account.
    for (const d of ['A', 'B'] as const) {
      await asDevice(d, async () => { await enableSync(uid) })
    }
    if (process.env.TWODEV_DEBUG) {
      const owner = require(`${SRC}/syncOwner.ts`)
      for (const d of ['A', 'B'] as const) {
        await asDevice(d, async () => {
          console.log(`  [debug ${d}] currentUserId=${await owner.currentUserId()}`)
          console.log(`  [debug ${d}] belongsTo=${await owner.localDataBelongsTo(uid)}`)
          console.log(`  [debug ${d}] keys=${JSON.stringify([...stores[d].keys()])}`)
        })
      }
    }

    console.log('\n--- 1. A bookmarks something. Does B see it? ---')
    await asDevice('A', async () => {
      await bookmarks.toggleBookmark(FAR_91_155)
    })
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    let onB = await asDevice('B', async () => await bookmarks.getBookmarks())
    check('B pulled the bookmark A made', onB.some((b: any) => b.id === '91.155'),
      JSON.stringify(onB.map((b: any) => b.id)))

    if (process.env.TWODEV_DEBUG) {
      const bm = await admin('GET', `/rest/v1/synced_bookmarks?user_id=eq.${uid}&select=id,deleted`)
      console.log('  [debug] server synced_bookmarks:', JSON.stringify(bm.body))
    }

    console.log('\n--- 2. B writes a note. Does A see it? ---')
    const noteId = `n-${Date.now()}`
    await asDevice('B', async () => {
      await writeNote({ id: noteId, title: 'From the iPad', body: 'written on device B',
        linked_ac: null, updated_at: new Date().toISOString() })
    })
    await settle()
    await asDevice('A', async () => { await pullAndMergeAll(uid) })
    let onA = await asDevice('A', async () => await notes.getNotes())
    check('A pulled the note B wrote', onA.some((n: any) => n.id === noteId),
      JSON.stringify(onA.map((n: any) => n.id)))

    if (process.env.TWODEV_DEBUG) {
      const sn = await admin('GET', `/rest/v1/synced_notes?user_id=eq.${uid}&select=id,updated_at`)
      console.log('  [debug] server synced_notes:', JSON.stringify(sn.body))
    }

    console.log('\n--- 3. A un-bookmarks it. Does the removal reach B? ---')
    await asDevice('A', async () => {
      await bookmarks.toggleBookmark(FAR_91_155)
    })
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    onB = await asDevice('B', async () => await bookmarks.getBookmarks())
    check('the un-bookmark propagated to B (a deletion must travel, not just an add)',
      !onB.some((b: any) => b.id === '91.155'), JSON.stringify(onB.map((b: any) => b.id)))

    console.log('\n--- 4. Does a pull ever DESTROY what the other device just made? ---')
    // The failure mode that has actually bitten this app: a device syncs and
    // its own un-pushed local work disappears. Make something on each device
    // WITHOUT letting the other pull first, then sync both and require that
    // both survive.
    const noteA = `na-${Date.now()}`
    const noteB = `nb-${Date.now()}`
    await asDevice('A', async () => {
      await writeNote({ id: noteA, title: 'A only', body: 'made on A',
        linked_ac: null, updated_at: new Date().toISOString() })
    })
    await asDevice('B', async () => {
      await writeNote({ id: noteB, title: 'B only', body: 'made on B',
        linked_ac: null, updated_at: new Date().toISOString() })
    })
    await settle()
    await asDevice('A', async () => { await pullAndMergeAll(uid) })
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    onA = await asDevice('A', async () => await notes.getNotes())
    onB = await asDevice('B', async () => await notes.getNotes())
    const idsA = onA.map((n: any) => n.id)
    const idsB = onB.map((n: any) => n.id)
    check('A kept its own note through a pull', idsA.includes(noteA), JSON.stringify(idsA))
    check('A gained the note B made', idsA.includes(noteB), JSON.stringify(idsA))
    check('B kept its own note through a pull', idsB.includes(noteB), JSON.stringify(idsB))
    check('B gained the note A made', idsB.includes(noteA), JSON.stringify(idsB))

    console.log('\n--- 5. Both devices edit the same note. Is either edit lost silently? ---')
    // Last-writer-wins is the design. What must NOT happen is the note
    // vanishing, or a device keeping a copy that disagrees with the server
    // forever.
    await asDevice('A', async () => {
      const cur = (await notes.getNotes()).find((n: any) => n.id === noteA)
      await writeNote({ ...cur, body: 'edited on A',
        updated_at: new Date(Date.now() - 5000).toISOString() })
    })
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    await asDevice('B', async () => {
      const cur = (await notes.getNotes()).find((n: any) => n.id === noteA)
      await writeNote({ ...cur, body: 'edited on B, later',
        updated_at: new Date().toISOString() })
    })
    await settle()
    await asDevice('A', async () => { await pullAndMergeAll(uid) })
    const finalA = (await asDevice('A', async () => await notes.getNotes()))
      .find((n: any) => n.id === noteA)
    check('the contested note still exists on A', !!finalA, 'it vanished')
    check('A converged on the LATER edit rather than keeping its own stale copy',
      finalA?.body === 'edited on B, later', JSON.stringify(finalA?.body))

    console.log('\n--- 6. Repeat pulls must be idempotent, not cumulative ---')
    const before = (await asDevice('B', async () => await notes.getNotes())).length
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    await settle()
    await asDevice('B', async () => { await pullAndMergeAll(uid) })
    const after = (await asDevice('B', async () => await notes.getNotes())).length
    check('two more pulls changed nothing (no duplicates, no losses)',
      after === before, `${before} -> ${after}`)

  } finally {
    await admin('DELETE', `/rest/v1/synced_notes?user_id=eq.${uid}`)
    await admin('DELETE', `/rest/v1/synced_bookmarks?user_id=eq.${uid}`)
    await admin('DELETE', `/auth/v1/admin/users/${uid}`)
  }

  console.log()
  if (failures.length) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('Both devices stayed in step: every add, every delete, every edit, both ways.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
