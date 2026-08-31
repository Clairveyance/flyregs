#!/usr/bin/env npx tsx
/**
 * Deterministic proof for the two client-side local-data-loss guards found in
 * the 2026-08-31 C1-C5 sync re-audit:
 *
 *   1. syncOwner.ts's setSyncOwner must never REGRESS a known email to null
 *      for the same account. The email is the entire same-person-different-
 *      backend-id signal that closed the 2026-08-26 real-data-loss incident,
 *      and claimDeviceIfMismatched's inconclusive (email-less) branch
 *      deliberately does NOT wipe -- so an email-less tag is what silently
 *      hands one account's local data to the next account that signs in.
 *      sync.ts's enableSync ends with a bare setSyncOwner(userId) and used to
 *      null it on every single Back-up & Sync enable.
 *
 *   2. sync.ts's mergeBookmarks must not honour a remote soft-delete that is
 *      OLDER than this device's copy. A whole-doc bookmark's id IS the
 *      document's own id (bookmarks.ts: "id === acId"), so it is reused on
 *      every re-bookmark -- an un-bookmark followed by a re-bookmark whose
 *      fire-and-forget push failed left a deleted=true remote row that
 *      silently deleted the re-added local bookmark on the next launch.
 *
 * Neither can be exercised on a real device/simulator from this environment
 * (gotcha_no_xcode_simulator_access.md), and both are about exact orderings
 * rather than anything observable by clicking -- so, exactly like
 * async_mutex_test.ts, this drives the REAL modules against a fake
 * AsyncStorage/supabase and asserts the semantics directly. Each fix also has
 * a CONTROL that re-runs the pre-fix logic and reproduces the real loss, so
 * neither is a strawman.
 *
 * Nothing here touches the network or the live database.
 *
 * Usage: npx tsx scripts/sync_owner_claim_test.ts
 */

// Runs under tsx's CJS transform (this file deliberately uses require(), not
// import, so the fakes below can be installed BEFORE the real modules load).
// The app's own tsconfig has no node/CJS globals, so declare the one used.
declare const __dirname: string

// ── fakes, installed before the real modules are loaded ──────────────────────
const store = new Map<string, string>()
const AsyncStorageFake = {
  getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: async (k: string, v: string) => void store.set(k, v),
  removeItem: async (k: string) => void store.delete(k),
}

let sessionUserId: string | null = null
let remoteRows: Record<string, any[]> = {}

/** Minimal thenable query builder -- every chained filter returns `this`, and
 * awaiting it yields { data } for whichever table `.from()` named. */
function makeBuilder(table: string) {
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    is: () => b,
    range: () => b,
    then: (resolve: any) => resolve({ data: remoteRows[table] ?? [], error: null }),
  }
  return b
}
const supabaseFake = {
  from: (table: string) => makeBuilder(table),
  rpc: async () => ({ data: null, error: null }),
  auth: {
    getSession: async () => ({ data: { session: sessionUserId ? { user: { id: sessionUserId } } : null } }),
    updateUser: () => ({ catch: () => {} }),
  },
}

const pushedBookmarkIds: string[] = []
let localBookmarks: any[] = []

const Module = require('module')
const origLoad = Module._load
Module._load = function (request: string) {
  switch (request) {
    case '@react-native-async-storage/async-storage':
      return { __esModule: true, default: AsyncStorageFake }
    case '@/lib/supabase':
      return { supabase: supabaseFake }
    case '@/lib/bookmarks':
      return { getBookmarks: async () => localBookmarks.map((b) => ({ ...b })) }
    case '@/lib/folders':
      return { getFolders: async () => [], getFolderItems: async () => [] }
    case '@/lib/notes':
      return {
        getNotes: async () => [],
        updateNotes: async (fn: any) => void fn([]),
        isSeedNote: (id: string) => id.startsWith('seed-'),
      }
    case '@/lib/syncPush':
      return {
        SYNC_ENABLED_KEY: '@flyregs/sync-enabled',
        isSyncEnabled: async () => true,
        syncPushBookmark: async (b: any) => void pushedBookmarkIds.push(b.id),
        syncPushFolder: async () => {},
        syncPushFolderItems: async () => {},
        syncPushNote: async () => {},
      }
    default:
      return origLoad.apply(this, arguments as any)
  }
}

const SRC = require('path').resolve(__dirname, '../src/lib')
const { setSyncOwner, getSyncOwner, localDataBelongsTo, claimDeviceIfMismatched, SYNC_OWNER_KEY } =
  require(`${SRC}/syncOwner.ts`)
const { pullAndMergeAll } = require(`${SRC}/sync.ts`)

let failures = 0
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`)
  if (!cond) failures++
}
function reset() {
  store.clear()
  localBookmarks = []
  remoteRows = {}
  pushedBookmarkIds.length = 0
}
const tag = async () => (store.has(SYNC_OWNER_KEY) ? JSON.parse(store.get(SYNC_OWNER_KEY)!) : null)

const A = { id: 'uid-A', email: 'ann@example.com' }
const B = { id: 'uid-B', email: 'bob@example.com' }
const LOCAL_KEYS = ['@flyregs/bookmarks', '@flyregs/folders', '@flyregs/notes', '@flyregs/recents']
const seedLocalData = () => LOCAL_KEYS.forEach((k) => store.set(k, JSON.stringify([{ id: 'A-owned' }])))
const localDataSurvives = () => LOCAL_KEYS.every((k) => store.has(k))
const localDataGone = () => LOCAL_KEYS.every((k) => !store.has(k))

async function main() {
  console.log('=== syncOwner.ts / sync.ts local-data-loss proof ===\n')

  // ── 1. the six account transitions from the audit brief ───────────────────
  console.log('1. account transitions -- what happens to local data\n')

  reset()
  await claimDeviceIfMismatched(A.id, A.email)
  check('signed out -> signed in, FRESH install: tag claimed, nothing to lose',
    (await tag())?.userId === A.id && (await tag())?.email === A.email, JSON.stringify(await tag()))

  reset()
  seedLocalData()
  await claimDeviceIfMismatched(A.id, A.email)
  check('signed out -> signed in, device had A\'s OWN unclaimed local data: kept (owner === null fast path)',
    localDataSurvives() && (await localDataBelongsTo(A.id)))

  reset()
  seedLocalData()
  await setSyncOwner(A.id, A.email)          // A signs out (claimLocalDataForSignedOutUser)
  await claimDeviceIfMismatched(B.id, B.email)
  check('account A signs out -> account B signs in: A\'s local data WIPED, tag reclaimed for B',
    localDataGone() && (await getSyncOwner()) === B.id)

  reset()
  seedLocalData()
  await claimDeviceIfMismatched(A.id, A.email)
  await setSyncOwner(A.id)                   // enableSync's bare re-stamp on a tier change
  await claimDeviceIfMismatched(A.id, A.email)
  check('tier upgrade/downgrade while signed in: local data untouched, email still on file',
    localDataSurvives() && (await tag())?.email === A.email, JSON.stringify(await tag()))

  reset()
  seedLocalData()
  await claimDeviceIfMismatched(A.id, A.email)
  await claimDeviceIfMismatched('uid-A-RESHAPED', A.email)   // same person, new backend id
  check('token refresh returning a DIFFERENT-shaped uid, same email: NOT wiped, tag re-pointed',
    localDataSurvives() && (await getSyncOwner()) === 'uid-A-RESHAPED')

  reset()
  seedLocalData()
  await setSyncOwner(A.id, A.email)
  const boom = { getItem: AsyncStorageFake.getItem, setItem: async () => { throw new Error('disk full') },
                 removeItem: AsyncStorageFake.removeItem }
  const saved = { ...AsyncStorageFake }
  Object.assign(AsyncStorageFake, boom)
  await claimDeviceIfMismatched(B.id, B.email)
  Object.assign(AsyncStorageFake, saved)
  check('failed/interrupted claim mid-write: throws are swallowed, tag stays A, read guard still hides A\'s data from B',
    (await getSyncOwner()) === A.id && !(await localDataBelongsTo(B.id)))

  // ── 2. FIX 1: setSyncOwner must not regress a known email ─────────────────
  console.log('\n2. FIX: enableSync\'s bare setSyncOwner(userId) must not null the email\n')

  reset()
  await claimDeviceIfMismatched(A.id, A.email)
  await setSyncOwner(A.id)                                  // exactly what enableSync does
  check('bare setSyncOwner(userId) PRESERVES the stored email for the same account',
    (await tag())?.email === A.email, JSON.stringify(await tag()))

  reset()
  await setSyncOwner(A.id, A.email)
  await setSyncOwner(B.id)                                  // different account, no email
  check('bare setSyncOwner for a DIFFERENT account does NOT inherit the previous person\'s email',
    (await tag())?.userId === B.id && (await tag())?.email === null, JSON.stringify(await tag()))

  // the full chain the regression actually caused
  reset()
  seedLocalData()
  await claimDeviceIfMismatched(A.id, A.email)   // A signs in
  await setSyncOwner(A.id)                       // A enables Back-up & Sync
  // A's session dies without signOut() (revoked/expired refresh token), so
  // claimLocalDataForSignedOutUser never runs. B signs in on the same device.
  await claimDeviceIfMismatched(B.id, B.email)
  check('CHAIN: A enables sync -> session dies without signOut -> B signs in: A\'s data is WIPED, not adopted by B',
    localDataGone(), 'A\'s local data survived and is now tagged as B\'s -- enableSync would upload it into B\'s cloud account')

  // CONTROL: the pre-fix setSyncOwner, to prove the chain above was real
  reset()
  seedLocalData()
  await claimDeviceIfMismatched(A.id, A.email)
  store.set(SYNC_OWNER_KEY, JSON.stringify({ userId: A.id, email: null }))  // pre-fix bare write
  await claimDeviceIfMismatched(B.id, B.email)
  check('CONTROL (pre-fix behaviour): an email-less tag lets B adopt A\'s local data -- the bug is real, not a strawman',
    localDataSurvives() && (await localDataBelongsTo(B.id)),
    'control did not reproduce -- re-check the claimDeviceIfMismatched branch this depends on')

  // ── 3. FIX 2: mergeBookmarks must not honour a STALE remote delete ────────
  console.log('\n3. FIX: mergeBookmarks must not honour a remote delete older than the local copy\n')

  const T1 = '2026-08-30T10:00:00.000Z'   // remote soft-delete
  const T2 = '2026-08-30T11:00:00.000Z'   // local re-bookmark (push failed)
  const T3 = '2026-08-30T12:00:00.000Z'   // a genuinely newer delete, from another device
  const DOC = 'AC-61-98'
  const bookmark = { id: DOC, acId: DOC, itemType: 'ac', document_number: '61-98', title: 'X',
                     date_issued: null, office: null, subject_series: null, savedAt: T2 }
  const readBack = async () => JSON.parse(store.get('@flyregs/bookmarks') ?? '[]')

  reset()
  sessionUserId = A.id
  await setSyncOwner(A.id, A.email)
  localBookmarks = [bookmark]
  remoteRows = { synced_bookmarks_gated: [{ id: DOC, user_id: A.id, deleted: true, updated_at: T1 }] }
  await pullAndMergeAll(A.id)
  const survivors = await readBack()
  check('re-bookmarked at T2, remote delete stamped T1: the bookmark SURVIVES the merge',
    survivors.length === 1 && survivors[0].id === DOC, JSON.stringify(survivors))
  check('...and is re-pushed so the cloud copy stops reading deleted (push_bookmark sets deleted = false)',
    pushedBookmarkIds.includes(DOC), JSON.stringify(pushedBookmarkIds))

  reset()
  await setSyncOwner(A.id, A.email)
  localBookmarks = [bookmark]
  remoteRows = { synced_bookmarks_gated: [{ id: DOC, user_id: A.id, deleted: true, updated_at: T3 }] }
  await pullAndMergeAll(A.id)
  const afterRealDelete = await readBack()
  check('NO REGRESSION: a genuinely NEWER remote delete (T3 > T2) still removes the local bookmark',
    afterRealDelete.length === 0, JSON.stringify(afterRealDelete))
  check('...and is not resurrected by a push either', !pushedBookmarkIds.includes(DOC))

  // CONTROL: the pre-fix unconditional delete
  {
    const merged = new Map([[DOC, bookmark]])
    for (const r of [{ id: DOC, deleted: true, updated_at: T1 }]) if (r.deleted) merged.delete(r.id)
    check('CONTROL (pre-fix behaviour): the unconditional delete loses the re-added bookmark -- the bug is real',
      merged.size === 0)
  }
  sessionUserId = null

  console.log(`\n=== ${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failure(s)) ===`)
  process.exit(failures ? 1 : 0)
}

main()
