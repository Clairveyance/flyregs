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
export function reportSyncError(context: string, error: { message: string } | null) {
  if (!error) return
  console.error(`[sync] ${context} failed:`, error.message)
  Sentry.captureException(new Error(`sync push failed (${context}): ${error.message}`))
}

// RC real-device Sentry, build 36 (2026-08-29, still firing on 09-03): a
// highlight created inside a shared folder this account has since lost write
// access to is rejected by enforce_folder_item_access, so it never lands
// remotely -- and mergeFolderItems' pushUp filter is "local row not present
// remotely", which that row can never satisfy. So it was re-queued and
// re-rejected on EVERY sync cycle, forever, firing a Sentry event each time.
// syncPushFolderItems' own header called this out as a known accepted gap;
// this closes it.
//
// Deliberately a COOLDOWN, not a permanent drop. Collaborator access can be
// re-granted, and abandoning the row outright would silently strand the
// user's own highlight forever -- the exact data-loss shape this project
// keeps fixing. A blocked row is skipped for BLOCKED_RETRY_MS and then tried
// once more; if access came back it syncs and clears, if not it goes quiet
// again for another week instead of every few minutes. Nothing local is ever
// deleted: the highlight stays on the device and stays visible either way.
const BLOCKED_ITEMS_KEY = '@flyregs/sync-blocked-items'
const BLOCKED_RETRY_MS = 7 * 24 * 60 * 60 * 1000

type BlockedEntry = { at: number; message: string }

async function readBlocked(): Promise<Record<string, BlockedEntry>> {
  try {
    const raw = await AsyncStorage.getItem(BLOCKED_ITEMS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, BlockedEntry>) : {}
  } catch {
    return {}
  }
}

async function writeBlocked(map: Record<string, BlockedEntry>): Promise<void> {
  try {
    await AsyncStorage.setItem(BLOCKED_ITEMS_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable -- worst case we retry next cycle, same as before */
  }
}

/** A denial the server will keep issuing no matter how often we retry (RLS
 * policy / access trigger), as opposed to a transient network or 5xx blip.
 * Matching on the access-trigger's own message plus Postgres' RLS wording;
 * anything unrecognised stays in the old retry-forever behaviour rather than
 * being wrongly given up on. */
function isPermanentDenial(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('do not have write access') ||
    m.includes('violates row-level security') ||
    m.includes('row-level security policy')
  )
}

/** Item ids currently inside their cooldown window -- skipped by this cycle's
 * push. Exported so sync.ts can filter them out of pushUp before the network
 * call, not just swallow the error afterwards. */
// Deletes that never reached the server, so the next pull cannot resurrect
// them.
//
// A delete push is fire-and-forget and can fail two ways that both look like
// success from the UI: currentUserId() returns null (RevenueCat unreachable
// -> {ok:false}, which is the OFFLINE case, i.e. exactly when a pilot is
// most likely to be using this app), or the RPC/UPDATE itself errors. Either
// way the remote row keeps `deleted=false`, and the very next merge sees a
// remote row with no local counterpart and writes it straight back to the
// device. The user deletes it again; it comes back again.
//
// syncPush.ts's own comment on the `ok` guard already spells this out --
// "the next merge resurrects the bookmark the user deleted" -- but the queue
// it implies was never built. Creates are self-healing (pullAndMergeAll's
// pushUp re-uploads anything the server lacks); deletes have no such path,
// because "absent remotely" is indistinguishable from "never pushed".
//
// Modelled on BLOCKED_ITEMS_KEY above: one small AsyncStorage record,
// best-effort writes, and never anything that can itself destroy data -- the
// worst case if this store is lost is the old behaviour.
const PENDING_DELETES_KEY = '@flyregs/sync-pending-deletes'

export type PendingDeleteKind = 'bookmarks' | 'notes' | 'folderItems'
type PendingDeletes = Record<PendingDeleteKind, string[]>

const EMPTY_PENDING: PendingDeletes = { bookmarks: [], notes: [], folderItems: [] }

export async function readPendingDeletes(): Promise<PendingDeletes> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_DELETES_KEY)
    if (!raw) return { ...EMPTY_PENDING }
    const parsed = JSON.parse(raw)
    // Shape-check every arm: a value of the wrong shape parses fine and then
    // throws later on .filter, far from the cause.
    return {
      bookmarks: Array.isArray(parsed?.bookmarks) ? parsed.bookmarks.filter((x: unknown) => typeof x === 'string') : [],
      notes: Array.isArray(parsed?.notes) ? parsed.notes.filter((x: unknown) => typeof x === 'string') : [],
      folderItems: Array.isArray(parsed?.folderItems) ? parsed.folderItems.filter((x: unknown) => typeof x === 'string') : [],
    }
  } catch {
    return { ...EMPTY_PENDING }
  }
}

async function writePendingDeletes(next: PendingDeletes): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable -- degrades to the previous behaviour, never worse */
  }
}

async function addPendingDeletes(kind: PendingDeleteKind, ids: string[]): Promise<void> {
  if (!ids.length) return
  const cur = await readPendingDeletes()
  cur[kind] = [...new Set([...cur[kind], ...ids])]
  await writePendingDeletes(cur)
}

/** Called after a delete genuinely lands, and by the merge drain below. */
export async function clearPendingDeletes(kind: PendingDeleteKind, ids: string[]): Promise<void> {
  if (!ids.length) return
  const cur = await readPendingDeletes()
  const drop = new Set(ids)
  const next = cur[kind].filter((id) => !drop.has(id))
  if (next.length === cur[kind].length) return
  cur[kind] = next
  await writePendingDeletes(cur)
}

export async function blockedFolderItemIds(): Promise<Set<string>> {
  const map = await readBlocked()
  const now = Date.now()
  return new Set(Object.keys(map).filter((id) => now - map[id].at < BLOCKED_RETRY_MS))
}

async function markBlocked(id: string, message: string): Promise<boolean> {
  const map = await readBlocked()
  const first = !map[id]
  map[id] = { at: Date.now(), message }
  await writeBlocked(map)
  return first
}

async function clearBlocked(ids: string[]): Promise<void> {
  if (!ids.length) return
  const map = await readBlocked()
  let changed = false
  for (const id of ids) {
    if (map[id]) { delete map[id]; changed = true }
  }
  if (changed) await writeBlocked(map)
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
  const { isPro, isPremium, ok } = await getSubscriptionStatus()
  // A FAILED lookup is not a downgrade. This was the fourth call site and the
  // only one that never got the `ok` guard the other three have: an
  // unreachable RevenueCat returns {false,false,false,ok:false} after its
  // retries, which is indistinguishable from a real downgrade, so every
  // syncPush* silently no-opped. Creates are eventually recovered by
  // pullAndMergeAll's push-up; DELETES are not -- soft_delete_bookmarks never
  // ran, the remote row still reads deleted=false, and the next merge
  // resurrects the bookmark the user deleted.
  if (!ok) return null
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
  if (!ids.length) return
  const userId = await currentUserId()
  // Queue BEFORE giving up: a null userId here is the offline case (see the
  // `ok` guard in currentUserId), and the local row is already gone, so
  // without this the delete is lost and the next pull resurrects it.
  if (!userId) { await addPendingDeletes('bookmarks', ids); return }
  // soft_delete_bookmarks RPC, not a raw UPDATE -- same reason as
  // syncPushBookmark's push_bookmark RPC above (sync/migrations_synced_
  // bookmarks_write_rpc.sql): this plain UPDATE also turned out to need
  // table-level SELECT once that grant was revoked, confirmed live before
  // shipping this change.
  const { error } = await supabase.rpc('soft_delete_bookmarks', { p_ids: ids })
  if (error) { await addPendingDeletes('bookmarks', ids); reportSyncError('bookmark delete', error); return }
  await clearPendingDeletes('bookmarks', ids)
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
  if (!error) {
    // A batch that went through proves every id in it is writable again --
    // clear any cooldown so a re-granted collaborator isn't left waiting out
    // the rest of a week for a row that would now sync fine.
    await clearBlocked(items.map((i) => i.id))
    return
  }
  reportSyncError('folder item upsert (batch)', error)
  const succeeded: string[] = []
  for (const item of items) {
    const { error: itemError } = await supabase
      .from('synced_folder_items')
      .upsert(folderItemRow(userId, item), { onConflict: 'user_id,id' })
    if (!itemError) {
      succeeded.push(item.id)
      continue
    }
    if (isPermanentDenial(itemError.message)) {
      // Report the FIRST time only. This used to fire on every sync cycle
      // forever for the same row, which is what made it visible in Sentry at
      // all -- the noise was the symptom, the endless retry was the bug.
      const first = await markBlocked(item.id, itemError.message)
      if (first) {
        reportSyncError(`folder item upsert (${item.item_type}:${item.item_id})`, itemError)
      } else {
        console.warn(`[sync] skipping ${item.item_type}:${item.item_id} -- still denied, cooling down`)
      }
      continue
    }
    // Transient/unknown failure: unchanged behaviour, report and retry next cycle.
    reportSyncError(`folder item upsert (${item.item_type}:${item.item_id})`, itemError)
  }
  await clearBlocked(succeeded)
}

export async function syncPushFolderItemDeletes(ids: string[], force = false) {
  if (!ids.length) return
  const userId = await currentUserId(force)
  // Queue BEFORE giving up: a null userId here is the offline case (see the
  // `ok` guard in currentUserId), and the local row is already gone, so
  // without this the delete is lost and the next pull resurrects it.
  if (!userId) { await addPendingDeletes('folderItems', ids); return }
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
  if (error) { await addPendingDeletes('folderItems', ids); reportSyncError('folder item delete', error); return }
  await clearPendingDeletes('folderItems', ids)
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
  if (!ids.length) return
  const userId = await currentUserId()
  // Queue BEFORE giving up: a null userId here is the offline case (see the
  // `ok` guard in currentUserId), and the local row is already gone, so
  // without this the delete is lost and the next pull resurrects it.
  if (!userId) { await addPendingDeletes('notes', ids); return }
  // No .eq('user_id', ...) filter -- same reasoning as
  // syncPushFolderItemDeletes above: RLS now correctly allows a folder
  // owner to delete a collaborator's note (owners_manage_shared_notes), and
  // filtering by user_id here would silently no-op that case.
  const { error } = await supabase
    .from('synced_notes')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .in('id', ids)
  if (error) { await addPendingDeletes('notes', ids); reportSyncError('note delete', error); return }
  await clearPendingDeletes('notes', ids)
}
