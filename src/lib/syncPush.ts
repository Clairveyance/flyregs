import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { getSubscriptionStatus } from '@/lib/revenuecat'
import type { BookmarkAC } from '@/lib/bookmarks'
import type { Folder, FolderItem } from '@/lib/folders'
import type { Note } from '@/lib/notes'

// Split out from sync.ts specifically so bookmarks.ts/folders.ts/notes.ts can
// import push functions without creating a require cycle — this file only
// needs types (erased at compile time) from those modules, never their
// runtime local-storage readers, so the dependency graph stays one-directional:
// bookmarks/folders/notes -> syncPush -> supabase. The pull/merge logic in
// sync.ts (which DOES need to read local storage) imports from this file too,
// but nothing here imports back from sync.ts.

export const SYNC_ENABLED_KEY = '@flyregs/sync-enabled'

export async function isSyncEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(SYNC_ENABLED_KEY)) === 'true'
}

// `force` bypasses the global Back up & sync toggle -- used only for the
// specific rows a shared folder actually needs in the cloud (the folder
// itself, its item pointers, and any notes among those items), so that
// folder sharing works independent of whether the user has opted into
// backing up their whole library. Premium/session still apply either way --
// force only skips the sync_enabled check, never the entitlement check.
async function currentUserId(force = false): Promise<string | null> {
  if (!force && !(await isSyncEnabled())) return null
  // The sync_enabled flag only reflects that the user turned it on at some
  // point -- it doesn't get flipped off if their subscription later lapses.
  // Re-check live entitlement on every push so a downgraded Premium user
  // can't keep getting free cloud sync just because the local flag is stale.
  const { isPremium } = await getSubscriptionStatus()
  if (!isPremium) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

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
      ac_id: b.acId ?? b.id,
      block_kind: b.blockKind ?? null,
      block_label: b.blockLabel ?? null,
      block_snippet: b.blockSnippet ?? null,
      block_text: b.blockText ?? null,
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

export async function syncPushFolder(f: Folder, force = false) {
  const userId = await currentUserId(force)
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

export async function syncPushFolderItems(items: FolderItem[], force = false) {
  const userId = await currentUserId(force)
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

export async function syncPushFolderItemDeletes(ids: string[], force = false) {
  const userId = await currentUserId(force)
  if (!userId || !ids.length) return
  await supabase
    .from('synced_folder_items')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
}

export async function syncPushNote(n: Note, force = false) {
  const userId = await currentUserId(force)
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
