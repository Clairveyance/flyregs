import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { getBookmarks } from '@/lib/bookmarks'
import { getFolders, getFolderItems } from '@/lib/folders'
import { getNotes, saveNotes, isSeedNote } from '@/lib/notes'
import {
  SYNC_ENABLED_KEY,
  isSyncEnabled,
  syncPushBookmark,
  syncPushFolder,
  syncPushFolderItems,
  syncPushNote,
} from '@/lib/syncPush'

// Real cloud sync for Premium's "Back up & sync" — replaces the previous
// AsyncStorage-only toggle that never actually talked to a server. One
// shared enabled-flag drives bookmarks, folders, and notes together (the
// two screens used to track this independently, which meant a user could
// have sync "on" for notes but "off" for bookmarks with no indication why).
//
// The push functions themselves live in syncPush.ts, not here — they're
// called directly from bookmarks.ts/folders.ts/notes.ts after each local
// mutation, and importing this file (which reads local storage back) from
// there would create a require cycle. This file only ever imports FROM
// those modules, never the other way around.

export { SYNC_ENABLED_KEY, isSyncEnabled }

const FOLDERS_KEY = '@flyregs/folders'
const FOLDER_ITEMS_KEY = '@flyregs/folder_items'
const BOOKMARKS_KEY = '@flyregs/bookmarks'

// Which account this device's local data was last backed up under.
//
// Every local store (@flyregs/bookmarks, /folders, /folder_items, /notes) is
// GLOBAL -- no per-user namespacing -- and signOut deliberately leaves them in
// place so bookmarks keep working without an account or sync. On its own
// that's fine. The problem was what happened next: applyRemoteSyncPreference
// runs on every sign-in, and for a Premium account whose stored preference is
// sync_enabled=true it called enableSync(), which bulk-pushes EVERY local
// bookmark, folder and note to whoever just signed in. So on a shared device
// (flight school, family iPad, a beta tester handing their phone over), user
// A's saved items -- including their own authored notes -- were silently
// uploaded into user B's cloud account with no prompt and no action beyond
// signing in.
//
// This tag is the guard: the bulk push only runs when the local data already
// belongs to the account turning sync on. Any mismatch is pull-only, so B
// still gets their own cloud data down onto the device, but nothing of A's
// ever goes up. Deliberately NOT a "wipe local data on sign-out" fix, which
// would break local-first bookmarks, and not per-user namespacing, which
// would be a much larger change.
const SYNC_OWNER_KEY = '@flyregs/sync-owner'

async function getSyncOwner(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SYNC_OWNER_KEY)
  } catch {
    return null
  }
}

async function setSyncOwner(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SYNC_OWNER_KEY, userId)
  } catch {
    // Non-fatal: a failed write just means the next enableSync is treated as
    // a first-time/unknown owner, which is the conservative direction.
  }
}

// Called from signOut. Stamps the departing user as the owner of whatever is
// left on this device, which closes the case the enableSync guard alone
// can't see: a user who was signed in but never turned sync on has no owner
// tag, so the next account to sign in would read null ("nobody has claimed
// this, must be mine") and upload their items. Recording it on the way out
// means the next user reads a real, different owner and gets pull-only.
//
// Still deliberately open: someone who has NEVER signed in on this device
// leaves no tag at all, so their local items would upload to the first
// account that signs in and enables sync. That case is indistinguishable
// from the genuinely common and desirable one -- browse anonymously, like
// the app, create an account, and expect your saved work to come with you --
// so it is left to upload on purpose rather than silently dropped.
export async function claimLocalDataForSignedOutUser(userId: string): Promise<void> {
  await setSyncOwner(userId)
}

// ── Pull + merge (called when sync is turned on, and on app launch) ──────────
// Last-write-wins by updated_at. A remote row newer than the local copy (or
// with no local copy at all) wins; a local row with no remote copy yet gets
// pushed up. Soft-deleted remote rows remove the local copy if the remote
// delete is newer than whatever's on this device.

export async function pullAndMergeAll(userId: string): Promise<void> {
  await Promise.all([
    mergeBookmarks(userId),
    mergeFolders(userId),
    mergeFolderItems(userId),
    mergeNotes(userId),
  ])
}

async function mergeBookmarks(userId: string) {
  const [{ data: remote }, local] = await Promise.all([
    supabase.from('synced_bookmarks').select('*').eq('user_id', userId),
    getBookmarks(),
  ])
  const localById = new Map(local.map((b) => [b.id, b]))
  const merged = new Map(localById)

  for (const r of remote ?? []) {
    if (r.deleted) {
      merged.delete(r.id)
      continue
    }
    if (!localById.has(r.id)) {
      merged.set(r.id, {
        id: r.id,
        // Missing means 'ac' (see bookmarks.ts's own BookmarkAC comment) --
        // was never restored here at all before this fix, so any FAR/AIM/
        // AD/PCG/LOI bookmark that round-tripped through cloud sync (new
        // device, reinstall, restore) silently reverted to 'ac' and then
        // mis-routed via routeForBookmark(). Confirmed live via the #154
        // process-flow audit.
        itemType: r.item_type ?? undefined,
        document_number: r.document_number,
        title: r.title,
        date_issued: r.date_issued,
        office: r.office,
        subject_series: r.subject_series,
        savedAt: r.saved_at,
        acId: r.ac_id ?? r.id,
        blockKind: r.block_kind ?? undefined,
        blockLabel: r.block_label ?? undefined,
        blockSnippet: r.block_snippet ?? undefined,
        blockText: r.block_text ?? undefined,
      })
    }
  }
  const toPushUp = local.filter((loc) => !(remote ?? []).some((r) => r.id === loc.id))

  await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify([...merged.values()]))
  for (const b of toPushUp) await syncPushBookmark(b)
}

async function mergeFolders(userId: string) {
  const [{ data: remote }, local] = await Promise.all([
    supabase.from('synced_folders').select('*').eq('user_id', userId),
    getFolders(),
  ])
  const localById = new Map(local.map((f) => [f.id, f]))
  const merged = new Map(localById)

  for (const r of remote ?? []) {
    const loc = localById.get(r.id)
    const remoteNewer = !loc || new Date(r.updated_at) > new Date(loc.updated_at)
    if (r.deleted) {
      if (remoteNewer) merged.delete(r.id)
      continue
    }
    if (remoteNewer) {
      merged.set(r.id, { id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at })
    }
  }
  const toPushUp = local.filter((loc) => {
    const r = (remote ?? []).find((x) => x.id === loc.id)
    return !r || new Date(loc.updated_at) > new Date(r.updated_at)
  })

  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...merged.values()]))
  for (const f of toPushUp) await syncPushFolder(f)
}

async function mergeFolderItems(userId: string) {
  const [{ data: remote }, local] = await Promise.all([
    supabase.from('synced_folder_items').select('*').eq('user_id', userId),
    getFolderItems(),
  ])
  const localById = new Map(local.map((i) => [i.id, i]))
  const merged = new Map(localById)

  for (const r of remote ?? []) {
    if (r.deleted) {
      merged.delete(r.id)
      continue
    }
    if (!localById.has(r.id)) {
      merged.set(r.id, { id: r.id, folder_id: r.folder_id, item_type: r.item_type, item_id: r.item_id, added_at: r.added_at })
    }
  }
  const toPushUp = local.filter((loc) => !(remote ?? []).some((r) => r.id === loc.id))

  await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify([...merged.values()]))
  await syncPushFolderItems(toPushUp)
}

async function mergeNotes(userId: string) {
  const [{ data: remote }, local] = await Promise.all([
    supabase.from('synced_notes').select('*').eq('user_id', userId),
    getNotes(),
  ])
  const localById = new Map(local.map((n) => [n.id, n]))
  const merged = new Map(localById)

  for (const r of remote ?? []) {
    const loc = localById.get(r.id)
    const remoteNewer = !loc || new Date(r.updated_at) > new Date(loc.updated_at)
    if (r.deleted) {
      if (remoteNewer) merged.delete(r.id)
      continue
    }
    if (remoteNewer) {
      merged.set(r.id, { id: r.id, title: r.title, body: r.body, linked_ac: r.linked_ac, updated_at: r.updated_at })
    }
  }
  const toPushUp = local.filter((loc) => {
    if (isSeedNote(loc.id)) return false
    const r = (remote ?? []).find((x) => x.id === loc.id)
    return !r || new Date(loc.updated_at) > new Date(r.updated_at)
  })

  await saveNotes([...merged.values()])
  for (const n of toPushUp) await syncPushNote(n)
}

// ── Turning sync on/off ────────────────────────────────────────────────────────
// Turning on pushes everything currently on this device up, then reconciles
// with whatever's already on the server (covers the case where sync was
// previously enabled on a different device with different content). The
// preference itself is also written to the account (user_metadata), not just
// this device's local storage, so signing into a *different* device with the
// same account picks up the same on/off state automatically — see
// applyRemoteSyncPreference, called on app launch in context/auth.tsx.
export async function enableSync(userId: string): Promise<void> {
  await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'true')
  try {
    // Only upload what already belongs to this account. A null owner means
    // this device has never backed up before, so the local data is this
    // user's own first backup and SHOULD go up -- that's the normal path and
    // is unchanged. A DIFFERENT owner means someone else's items are sitting
    // in the global local store (see SYNC_OWNER_KEY), and pushing them would
    // put their bookmarks and authored notes into this account. Skip the
    // push in that case and pull only.
    const owner = await getSyncOwner()
    const localBelongsToThisUser = owner === null || owner === userId

    if (localBelongsToThisUser) {
      const [bookmarks, folders, folderItems, notes] = await Promise.all([
        getBookmarks(),
        getFolders(),
        getFolderItems(),
        getNotes(),
      ])
      await Promise.all([
        ...bookmarks.map((b) => syncPushBookmark(b)),
        ...folders.map((f) => syncPushFolder(f)),
        syncPushFolderItems(folderItems),
        ...notes.filter((n) => !isSeedNote(n.id)).map((n) => syncPushNote(n)),
      ])
    }
    // Always pull, both paths: this account's own cloud data belongs on this
    // device either way, and on the mismatch path it's the whole point --
    // the new user still gets everything of theirs without giving anything up.
    await pullAndMergeAll(userId)
    // Claim ownership only after a clean push+pull, so a failure can't leave
    // the tag pointing at an account whose data never actually landed.
    await setSyncOwner(userId)
  } catch (e) {
    // Roll the flag back so it can't disagree with the caller's own reverted
    // UI state (saved.tsx/notes.tsx both flip their Switch back off on a
    // thrown enableSync) -- found live: a transient failure here left
    // AsyncStorage's flag stuck at 'true' with the toggle showing off,
    // which made isSyncEnabled() (and therefore every later bookmark/folder/
    // note push) silently succeed despite the user seeing an error and the
    // initial bulk push/pull never having completed.
    await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'false')
    throw e
  }
  // Cross-device preference write is best-effort -- it records that OTHER
  // devices should auto-enable sync too, but it isn't the backup itself.
  // Firing it after the real push/pull (rather than blocking on it first)
  // means a transient failure here can't abort or roll back a backup that
  // already succeeded; the next successful enable/disable, or app-launch's
  // applyRemoteSyncPreference, will reconcile it.
  supabase.auth.updateUser({ data: { sync_enabled: true } }).catch(() => {})
}

export async function disableSync(): Promise<void> {
  await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'false')
  await supabase.auth.updateUser({ data: { sync_enabled: false } })
}

// Called once per app launch (see context/auth.tsx). Reconciles this
// device's local sync flag against the account-level preference:
//   - remote true, local off  -> turn on here too (pulls the account's data down)
//   - remote false, local on  -> turn off here too
//   - remote never set        -> this is either a fresh account, or an
//     existing device that enabled sync before this cross-device preference
//     existed. Seed the remote value from whatever's already true locally
//     (a false local default needs no seeding — false is already the
//     implicit default for an unset preference).
export async function applyRemoteSyncPreference(userId: string, remoteSyncEnabled: unknown): Promise<void> {
  const local = await isSyncEnabled()
  if (remoteSyncEnabled === true && !local) {
    await enableSync(userId)
  } else if (remoteSyncEnabled === false && local) {
    await disableSync()
  } else if (remoteSyncEnabled == null && local) {
    // Best-effort for the same reason as enableSync's own preference write
    // above -- this fires unawaited from auth.tsx on every app launch, so an
    // unguarded throw here would surface as a console warning on any
    // transient blip for no benefit (nothing awaits or reacts to it).
    supabase.auth.updateUser({ data: { sync_enabled: true } }).catch(() => {})
  }
}
