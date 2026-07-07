import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { getBookmarks, type BookmarkAC } from '@/lib/bookmarks'
import { getFolders, getFolderItems, type Folder, type FolderItem } from '@/lib/folders'
import { getNotes, saveNotes, type Note } from '@/lib/notes'

// Real cloud sync for Premium's "Back up & sync" — replaces the previous
// AsyncStorage-only toggle that never actually talked to a server. One
// shared enabled-flag drives bookmarks, folders, and notes together (the
// two screens used to track this independently, which meant a user could
// have sync "on" for notes but "off" for bookmarks with no indication why).
//
// Every push function here checks sync-enabled + session itself and no-ops
// if either is missing, so call sites in bookmarks.ts/folders.ts/notes.ts can
// just fire-and-forget after a local mutation without threading userId or a
// sync-enabled flag through every function signature.

export const SYNC_ENABLED_KEY = '@flyregs/sync-enabled'

export async function isSyncEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(SYNC_ENABLED_KEY)) === 'true'
}

async function currentUserId(): Promise<string | null> {
  if (!(await isSyncEnabled())) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

const FOLDERS_KEY = '@flyregs/folders'
const FOLDER_ITEMS_KEY = '@flyregs/folder_items'
const BOOKMARKS_KEY = '@flyregs/bookmarks'

// ── Push (fire-and-forget; called from each local mutation site) ─────────────

export async function syncPushBookmark(b: BookmarkAC) {
  const userId = await currentUserId()
  if (!userId) return
  await supabase.from('synced_bookmarks').upsert(
    {
      id: b.id,
      user_id: userId,
      document_number: b.document_number,
      title: b.title,
      date_issued: b.date_issued,
      office: b.office,
      subject_series: b.subject_series,
      saved_at: b.savedAt,
      updated_at: new Date().toISOString(),
      deleted: false,
    },
    { onConflict: 'user_id,id' }
  )
}

export async function syncPushBookmarkDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  await supabase
    .from('synced_bookmarks')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
}

export async function syncPushFolder(f: Folder) {
  const userId = await currentUserId()
  if (!userId) return
  await supabase.from('synced_folders').upsert(
    { id: f.id, user_id: userId, name: f.name, created_at: f.created_at, updated_at: f.updated_at, deleted: false },
    { onConflict: 'user_id,id' }
  )
}

export async function syncPushFolderDelete(id: string) {
  const userId = await currentUserId()
  if (!userId) return
  await supabase
    .from('synced_folders')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', id)
}

export async function syncPushFolderItems(items: FolderItem[]) {
  const userId = await currentUserId()
  if (!userId || !items.length) return
  await supabase.from('synced_folder_items').upsert(
    items.map((i) => ({
      id: i.id,
      user_id: userId,
      folder_id: i.folder_id,
      item_type: i.item_type,
      item_id: i.item_id,
      added_at: i.added_at,
      updated_at: new Date().toISOString(),
      deleted: false,
    })),
    { onConflict: 'user_id,id' }
  )
}

export async function syncPushFolderItemDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  await supabase
    .from('synced_folder_items')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
}

export async function syncPushNote(n: Note) {
  const userId = await currentUserId()
  if (!userId) return
  await supabase.from('synced_notes').upsert(
    { id: n.id, user_id: userId, title: n.title, body: n.body, linked_ac: n.linked_ac, updated_at: n.updated_at, deleted: false },
    { onConflict: 'user_id,id' }
  )
}

export async function syncPushNoteDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  await supabase
    .from('synced_notes')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
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
        document_number: r.document_number,
        title: r.title,
        date_issued: r.date_issued,
        office: r.office,
        subject_series: r.subject_series,
        savedAt: r.saved_at,
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
    const r = (remote ?? []).find((x) => x.id === loc.id)
    return !r || new Date(loc.updated_at) > new Date(r.updated_at)
  })

  await saveNotes([...merged.values()])
  for (const n of toPushUp) await syncPushNote(n)
}

// ── Turning sync on/off ────────────────────────────────────────────────────────
// Turning on pushes everything currently on this device up, then reconciles
// with whatever's already on the server (covers the case where sync was
// previously enabled on a different device with different content).
export async function enableSync(userId: string): Promise<void> {
  await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'true')
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
    ...notes.map((n) => syncPushNote(n)),
  ])
  await pullAndMergeAll(userId)
}

export async function disableSync(): Promise<void> {
  await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'false')
}
