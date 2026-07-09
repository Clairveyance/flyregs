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
  await supabase.auth.updateUser({ data: { sync_enabled: true } })
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
  await pullAndMergeAll(userId)
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
    await supabase.auth.updateUser({ data: { sync_enabled: true } })
  }
}
