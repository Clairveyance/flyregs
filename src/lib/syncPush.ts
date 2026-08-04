import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Sentry from '@sentry/react-native'
import { supabase } from '@/lib/supabase'
import { getSubscriptionStatus } from '@/lib/revenuecat'
import type { BookmarkAC } from '@/lib/bookmarks'
import type { Folder, FolderItem } from '@/lib/folders'
import type { Note } from '@/lib/notes'

// supabase-js query builder calls resolve with { data, error } -- they don't
// throw on a Postgres-level failure (RLS denial, CHECK constraint, etc.)
// unless you opt into .throwOnError(). Every push function below used to
// await its upsert/update and never look at the returned error, so a bad
// constraint failed COMPLETELY silently: no thrown exception, no console
// output, nothing -- found live 2026-08-02 when synced_folder_items'
// item_type CHECK constraint didn't include 'dictionary' (added with
// Aviation Dictionary v1) and every dictionary/mnemonic folder-add had been
// failing to sync since, with zero signal anywhere. Surfacing to both
// console and Sentry means the NEXT constraint/RLS gap (e.g. a future
// content type) fails loudly instead of silently.
function reportSyncError(context: string, error: { message: string } | null) {
  if (!error) return
  console.error(`[sync] ${context} failed:`, error.message)
  Sentry.captureException(new Error(`sync push failed (${context}): ${error.message}`))
}

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
// backing up their whole library. Entitlement still applies either way --
// force only skips the sync_enabled check, never the entitlement check.
async function currentUserId(force = false): Promise<string | null> {
  if (!force && !(await isSyncEnabled())) return null
  // The sync_enabled flag only reflects that the user turned it on at some
  // point -- it doesn't get flipped off if their subscription later lapses.
  // Re-check live entitlement on every push so a downgraded subscriber can't
  // keep getting free cloud sync just because the local flag is stale.
  // General sync moved from Premium to Pro in the pricing pivot -- see
  // flyregs_decisions.md -- but shared-folder force-pushes stay Premium-
  // gated, since collaboration itself is still Premium-only and unchanged.
  const { isPro, isPremium } = await getSubscriptionStatus()
  if (!(force ? isPremium : isPro)) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

export async function syncPushBookmark(b: BookmarkAC) {
  const userId = await currentUserId()
  if (!userId) return
  const { error } = await supabase.from('synced_bookmarks').upsert(
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
      item_type: b.itemType ?? null,
      ac_id: b.acId ?? b.id,
      block_kind: b.blockKind ?? null,
      block_label: b.blockLabel ?? null,
      block_snippet: b.blockSnippet ?? null,
      block_text: b.blockText ?? null,
    },
    { onConflict: 'user_id,id' }
  )
  reportSyncError('bookmark upsert', error)
}

export async function syncPushBookmarkDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  const { error } = await supabase
    .from('synced_bookmarks')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
  reportSyncError('bookmark delete', error)
}

export async function syncPushFolder(f: Folder, force = false) {
  const userId = await currentUserId(force)
  if (!userId) return
  const { error } = await supabase.from('synced_folders').upsert(
    { id: f.id, user_id: userId, name: f.name, created_at: f.created_at, updated_at: f.updated_at, deleted: false, sort_order: f.sort_order ?? null },
    { onConflict: 'user_id,id' }
  )
  reportSyncError('folder upsert', error)
}

export async function syncPushFolderDelete(id: string) {
  const userId = await currentUserId()
  if (!userId) return
  const { error } = await supabase
    .from('synced_folders')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', id)
  reportSyncError('folder delete', error)
}

export async function syncPushFolderItems(items: FolderItem[], force = false) {
  const userId = await currentUserId(force)
  if (!userId || !items.length) return
  const { error } = await supabase.from('synced_folder_items').upsert(
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
  reportSyncError('folder item upsert', error)
}

export async function syncPushFolderItemDeletes(ids: string[], force = false) {
  const userId = await currentUserId(force)
  if (!userId || !ids.length) return
  // No .eq('user_id', ...) filter -- RLS is the real authority here, and it
  // now correctly allows more than "delete my own rows": a folder owner can
  // remove an item a collaborator added, and an editor-collaborator on a
  // read_write folder can remove anyone's item, not just their own (see
  // sync/migrations_folder_readwrite_sharing.sql's owners_manage_own_/
  // editors_manage_shared_folder_items policies). Filtering by user_id here
  // would silently no-op exactly those cases -- the local removal would
  // still go through, but the remote row would never actually get marked
  // deleted and would reappear on the next pull.
  const { error } = await supabase
    .from('synced_folder_items')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .in('id', ids)
  reportSyncError('folder item delete', error)
}

export async function syncPushNote(n: Note, force = false) {
  const userId = await currentUserId(force)
  if (!userId) return
  const { error } = await supabase.from('synced_notes').upsert(
    { id: n.id, user_id: userId, title: n.title, body: n.body, linked_ac: n.linked_ac, updated_at: n.updated_at, deleted: false },
    { onConflict: 'user_id,id' }
  )
  reportSyncError('note upsert', error)
}

export async function syncPushNoteDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  // No .eq('user_id', ...) filter -- same reasoning as
  // syncPushFolderItemDeletes above: RLS now correctly allows a folder
  // owner to delete a collaborator's note (owners_manage_shared_notes), and
  // filtering by user_id here would silently no-op that case.
  const { error } = await supabase
    .from('synced_notes')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .in('id', ids)
  reportSyncError('note delete', error)
}
