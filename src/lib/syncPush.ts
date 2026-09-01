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
  // hasProAccess (isPro || isPremium), not bare isPro -- found in the
  // 2026-08-14 gating re-audit: this read RevenueCat's two entitlements
  // independently, so a genuine Premium subscriber whose account only has
  // the 'premium' entitlement active (isPro: false, isPremium: true -- a
  // real shape for an admin/comp-granted entitlement, same class of bug
  // already found and fixed in saved.tsx/notes.tsx/study.tsx/my-aircraft/
  // index.tsx/(tabs)/index.tsx/ad/index.tsx) would silently fail this
  // check on every single push call. Worse than those UI-level bugs: there
  // was no paywall redirect and no error anywhere -- currentUserId just
  // returned null and every syncPush* function no-ops on `if (!userId)
  // return`, so "Back up & sync" would show as ON in the UI (saved.tsx's
  // own toggle already correctly gates display on hasProAccess) while
  // silently never actually pushing anything to the cloud.
  if (!(force ? isPremium : (isPro || isPremium))) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

/** `preResolvedUserId` lets a caller that is pushing MANY bookmarks in a row
 * resolve the user/entitlement ONCE instead of per bookmark. currentUserId
 * calls getSubscriptionStatus(), an uncached RevenueCat native call with up to
 * 3 retries at 300/600/900ms backoff, so a 20-item shared folder was making
 * ~20 of them before the share sheet could render (RC: "takes a long long time
 * to open"). Bookmarks go through the single-row push_bookmark SECURITY
 * DEFINER RPC, so unlike notes they cannot be batched into one statement
 * without a new server-side RPC -- hoisting the entitlement check is the
 * contained half of that win.
 *
 * This does NOT weaken the gate: push_bookmark takes user_id from auth.uid()
 * server-side and never trusts the caller, so RLS governs every write whatever
 * this resolves to. Omit the argument and behaviour is exactly as before. */
/** Resolve the pushing user once, for callers that then push many rows.
 * Same check currentUserId performs internally -- exported so a bulk path can
 * pay for it once rather than per row. */
export async function resolvePushUserId(force = false): Promise<string | null> {
  return currentUserId(force)
}

export async function syncPushBookmark(b: BookmarkAC, force = false, preResolvedUserId?: string | null) {
  const userId = preResolvedUserId !== undefined ? preResolvedUserId : await currentUserId(force)
  if (!userId) return
  // push_bookmark RPC, not a raw upsert -- see
  // sync/migrations_synced_bookmarks_write_rpc.sql. A raw INSERT ... ON
  // CONFLICT needs table-level SELECT to evaluate the conflict, which was
  // the last reason anon/authenticated still had any direct grant on
  // synced_bookmarks' gated columns (block_text/block_snippet) at all --
  // this SECURITY DEFINER RPC does the identical write server-side (user_id
  // taken from auth.uid() internally, never trusted from the caller) so no
  // caller needs table access anymore.
  const { error } = await supabase.rpc('push_bookmark', {
    p_id: b.id,
    p_document_number: b.document_number,
    p_title: b.title,
    p_date_issued: b.date_issued,
    p_office: b.office,
    p_subject_series: b.subject_series,
    p_saved_at: b.savedAt,
    p_item_type: b.itemType ?? null,
    p_ac_id: b.acId ?? b.id,
    p_block_kind: b.blockKind ?? null,
    p_block_label: b.blockLabel ?? null,
    p_block_snippet: b.blockSnippet ?? null,
    p_block_text: b.blockText ?? null,
  })
  reportSyncError('bookmark upsert', error)
}

export async function syncPushBookmarkDeletes(ids: string[]) {
  const userId = await currentUserId()
  if (!userId || !ids.length) return
  // soft_delete_bookmarks RPC, not a raw UPDATE -- same reason as
  // syncPushBookmark's push_bookmark RPC above (sync/migrations_synced_
  // bookmarks_write_rpc.sql): this plain UPDATE also turned out to need
  // table-level SELECT once that grant was revoked, confirmed live before
  // shipping this change.
  const { error } = await supabase.rpc('soft_delete_bookmarks', { p_ids: ids })
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

// RC real-device gating audit, 2026-08-22: a plain .update() here silently
// affected 0 rows for any folder pushed over the visibility cap by a
// downgrade -- Postgres requires SELECT-policy visibility as a
// precondition for UPDATE to even find the row, and a hidden folder never
// satisfies folders_own_select's cap check. soft_delete_own_folder is a
// narrow security-definer RPC (scoped internally by auth.uid()) built
// specifically for this -- deletes correctly regardless of visibility,
// with no change to the general RLS policy.
export async function syncPushFolderDelete(id: string, force = false) {
  const userId = await currentUserId(force)
  if (!userId) return
  const { error } = await supabase.rpc('soft_delete_own_folder', { p_id: id })
  reportSyncError('folder delete', error)
}

const folderItemRow = (userId: string, i: FolderItem) => ({
  id: i.id,
  user_id: userId,
  folder_id: i.folder_id,
  item_type: i.item_type,
  item_id: i.item_id,
  added_at: i.added_at,
  updated_at: new Date().toISOString(),
  deleted: false,
})

// RC + Adriana real-device Sentry report, 2026-08-22: a single item this
// account no longer has write access to (enforce_folder_item_access's
// BEFORE INSERT trigger, sync/migrations_gating_sweep_batch3.sql -- collab
// access can legitimately go stale between local-write-time and
// sync-push-time) 400'd the WHOLE batched upsert, so every OTHER healthy
// item queued alongside it silently failed to sync too, even though
// nothing was wrong with them. Falls back to one upsert per item on a
// batch failure so one denied/stale item can't take down unrelated items
// -- each item's own success/failure is now independent and reported on
// its own line.
//
// Known, currently-accepted gap (not fixed here): a genuinely,
// permanently-denied item still isn't surfaced to the user or dropped from
// the local pending queue -- it silently retries and fails again every
// future sync cycle. The equivalent case for shared NOTES already has a
// real UI affordance (SharedNoteAccessLostError, folder/shared/[id].tsx) --
// extending that same idea to folder items needs its own local-storage +
// UI design (this runs from a background batch, not a live foreground
// screen a user is looking at), scoped separately rather than rushed in
// alongside this fix.
export async function syncPushFolderItems(items: FolderItem[], force = false) {
  const userId = await currentUserId(force)
  if (!userId || !items.length) return
  const { error } = await supabase
    .from('synced_folder_items')
    .upsert(items.map((i) => folderItemRow(userId, i)), { onConflict: 'user_id,id' })
  if (!error) return
  reportSyncError('folder item upsert (batch)', error)
  for (const item of items) {
    const { error: itemError } = await supabase
      .from('synced_folder_items')
      .upsert(folderItemRow(userId, item), { onConflict: 'user_id,id' })
    reportSyncError(`folder item upsert (${item.item_type}:${item.item_id})`, itemError)
  }
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

/** Batched sibling of syncPushNote, mirroring syncPushFolderItems' shape
 * exactly -- one upsert for the whole set, with a per-row retry loop if the
 * batch fails so a single bad row can't silently drop the rest.
 *
 * Why this exists: ensureFolderPushed (sharedFolders.ts) pushed notes ONE AT A
 * TIME via Promise.all(map(syncPushNote)). Every one of those calls
 * currentUserId(force), which calls getSubscriptionStatus() -- an UNCACHED
 * RevenueCat native call with up to 3 retries at 300/600/900ms backoff. So a
 * 20-item shared folder made ~20 network writes AND ~20 native entitlement
 * calls before the share sheet could even render, which is a direct cause of
 * RC's "the screen to try to send any sharing... takes a long long time to
 * open." Folder item pointers were already batched here; notes simply never
 * got the same treatment.
 *
 * The entitlement check is NOT weakened: currentUserId still runs, just once
 * for the batch instead of once per note, and RLS governs every write
 * server-side regardless. */
export async function syncPushNotes(notes: Note[], force = false) {
  const userId = await currentUserId(force)
  if (!userId || !notes.length) return
  const row = (n: Note) => ({
    id: n.id, user_id: userId, title: n.title, body: n.body,
    linked_ac: n.linked_ac, updated_at: n.updated_at, deleted: false,
  })
  const { error } = await supabase.from('synced_notes').upsert(notes.map(row), { onConflict: 'user_id,id' })
  if (!error) return
  reportSyncError('note upsert (batch)', error)
  // Same per-row fallback as syncPushFolderItems: one rejected row (an RLS
  // denial on a single note) must not poison the whole batch. This is the
  // exact failure REACT-NATIVE-G was, one table over.
  for (const n of notes) {
    const { error: noteError } = await supabase
      .from('synced_notes')
      .upsert(row(n), { onConflict: 'user_id,id' })
    reportSyncError(`note upsert (${n.id})`, noteError)
  }
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
