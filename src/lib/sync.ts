import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { getBookmarks } from '@/lib/bookmarks'
import { getFolders, getFolderItems } from '@/lib/folders'
import { getNotes, updateNotes, isSeedNote, type Note } from '@/lib/notes'
import { setSyncOwner, localDataBelongsTo } from '@/lib/syncOwner'
import { pullAppSettings, pushAllAppSettings } from '@/lib/appSettings'
import { withLock } from '@/lib/asyncMutex'
import type { FolderItem } from '@/lib/folders'
import {
  SYNC_ENABLED_KEY,
  isSyncEnabled,
  syncPushBookmark,
  syncPushFolder,
  syncPushFolderItems,
  blockedFolderItemIds,
  syncPushNote,
  reportSyncError,
  readPendingDeletes,
  clearPendingDeletes,
  syncPushBookmarkDeletes,
  syncPushNoteDeletes,
  syncPushFolderItemDeletes,
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
//
// getSyncOwner/setSyncOwner now live in syncOwner.ts, not here -- the local
// READERS (folders.ts/bookmarks.ts/notes.ts) need the same check for the
// READ direction (see that file's own comment for the leak this closes),
// and this file already imports FROM them, so they can't import back here.

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
export async function claimLocalDataForSignedOutUser(userId: string, email?: string | null): Promise<void> {
  await setSyncOwner(userId, email ?? null)
}

// ── Pull + merge (called when sync is turned on, and on app launch) ──────────
// Last-write-wins by updated_at. A remote row newer than the local copy (or
// with no local copy at all) wins; a local row with no remote copy yet gets
// pushed up. Soft-deleted remote rows remove the local copy if the remote
// delete is newer than whatever's on this device.

// A pull whose FAILURE must not read as "the server has nothing".
//
// supabase-js RESOLVES {data: null, error} on a network failure rather than
// rejecting, so `const { data: remote } = ...` followed by `remote ?? []`
// turned every failed pull into a silent no-op merge. pullAndMergeAll then
// resolved, setSyncOwner stamped the device, and enableSync returned
// normally -- so "Back up & sync" flipped to ON, wrote sync_enabled:true to
// the account, and told a paying user their library was backed up when zero
// rows had moved in either direction. saved.tsx and notes.tsx BOTH already
// wrap enableSync in try/catch with a revert + error dialog; that path was
// simply unreachable. enableSync's own catch also rolls SYNC_ENABLED_KEY
// back, and the launch-time caller is .catch()-guarded, so throwing here is
// safe at every call site.
function mustPull<T>(res: { data: T[] | null; error: any }, what: string): T[] {
  if (res.error) throw new Error(`sync pull ${what}: ${res.error.message}`)
  return res.data ?? []
}

// PostgREST caps a response at the project's max-rows (1000 here), silently:
// you get 1000 rows and no error, no indication more exist. Highlights are
// stored as ordinary synced_bookmarks rows, so a heavy annotator crosses
// 1000 well before 1000 documents -- and a truncated pull means the rest of
// their library never lands on a restored device, on any launch, forever.
// (It is under-delivery, not loss: truncation only omits REMOTE rows, and a
// deletion only fires on a row that is actually present with deleted=true.)
//
// mergeFolderItems already carried a defensive `.range(0, 1999)`; that is
// still a cap, just a higher one, and the other three pulls had none at all.
// `.order('id')` matters as much as the paging: without a stable sort the
// page boundaries are unspecified, so which rows you get is arbitrary.
async function pullAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  what: string,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let i = 0; i < 100; i++) {
    const rows = mustPull(await page(i * PAGE, i * PAGE + PAGE - 1), what)
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

// Re-issue any delete that never reached the server, BEFORE merging.
//
// Two jobs, and both are needed: re-attempting is what eventually clears the
// queue, and the returned Set is what stops this merge from writing the row
// back to the device in the meantime. Without the second half, an offline
// delete comes back on the very next pull -- see PENDING_DELETES_KEY in
// syncPush.ts for how a delete gets stranded in the first place.
//
// Deliberately best-effort: a still-failing retry simply leaves the id
// queued, and the id stays excluded from resurrection either way, so the
// user's delete keeps looking like a delete.
async function drainPendingDeletes(): Promise<{ bookmarks: Set<string>; notes: Set<string>; folderItems: Set<string> }> {
  const pending = await readPendingDeletes()
  try {
    if (pending.bookmarks.length) await syncPushBookmarkDeletes(pending.bookmarks)
    if (pending.notes.length) await syncPushNoteDeletes(pending.notes)
    if (pending.folderItems.length) await syncPushFolderItemDeletes(pending.folderItems)
  } catch {
    /* the push helpers already re-queue and report; never block the merge */
  }
  return {
    bookmarks: new Set(pending.bookmarks),
    notes: new Set(pending.notes),
    folderItems: new Set(pending.folderItems),
  }
}

export async function pullAndMergeAll(userId: string): Promise<void> {
  // TWO waves, not one Promise.all -- mergeFolderItems and mergeNotes both
  // scope themselves to the folders that exist LOCALLY (`getFolders()` ->
  // ownFolderIds), and that read resolves from AsyncStorage in milliseconds
  // while mergeFolders is still on the network. Run together, they therefore
  // saw the folder list from BEFORE the pull.
  //
  // On a device with no local folders yet -- a new phone, a reinstall, a
  // cleared cache: exactly the restore case sync exists for -- ownFolderIds
  // was deterministically empty, so `relevantRemote` filtered to nothing and
  // the user's folders all pulled down EMPTY. It self-corrected on the next
  // cold launch, which meant the entire first session after a restore showed
  // empty folders at the precise moment the user was checking whether their
  // data had survived -- and invited them to re-add or delete to "fix" it.
  //
  // Bookmarks stay in the first wave: nothing scopes to them.
  // Retry stranded deletes first, and carry their ids into the merges so a
  // delete that still cannot reach the server is not written back onto the
  // device in the meantime.
  const pendingDel = await drainPendingDeletes()
  await Promise.all([mergeBookmarks(userId, pendingDel.bookmarks), mergeFolders(userId),
    // Settings and selections travel with everything else when Back-up &
    // Sync is on (RC, 2026-09-04). Runs alongside rather than after: it
    // touches no key any merge below touches, so there is nothing to
    // serialize against, and a slow settings read must not delay folders.
    pullAppSettings(userId)])
  await Promise.all([
    mergeFolderItems(userId, pendingDel.folderItems),
    mergeNotes(userId, pendingDel.notes),
  ])
}

async function mergeBookmarks(userId: string, pendingDeleted: Set<string> = new Set()) {
  // synced_bookmarks_gated, not the raw table -- a highlight's block_text/
  // block_snippet is a verbatim copy of real Plus/Pro-gated body text (see
  // sync/migrations_fix_synced_bookmarks_highlight_gate_leak.sql), and this
  // pull runs on every "Back up & sync" enable/app-launch/reinstall
  // regardless of the CURRENT tier -- reading the raw table here would
  // silently resurrect a downgraded user's old highlights, full gated text
  // and all, straight into local storage. The view redacts those two
  // columns to null when the current session's tier no longer qualifies;
  // every other column (plain bookmark metadata) is unaffected.
  // The pre-network snapshot that used to feed `localById` is gone: every
  // decision below now reads fresh inside the lock, so a second, older copy
  // out here could only be a source of exactly the staleness this fixes.
  const remote = await pullAllPages((f, t) =>
    supabase.from('synced_bookmarks_gated').select('*').eq('user_id', userId).order('id').range(f, t), 'bookmarks')
  // withLock('bookmarks', ...) -- the SAME lock key bookmarks.ts's own
  // addBookmark/addManyBookmarks/removeManyBookmarks/addHighlight now use,
  // so this merge and a concurrent local write can never race: whichever
  // acquires the lock first fully finishes before the other starts. Reads
  // fresh right before writing AND deciding against that same fresh read.
  // (Until 2026-09-04 only the base list was fresh; the decision still used
  // a snapshot taken before the network round-trip, which is the hole that
  // let a concurrent local write be judged against its own old value.) See
  // asyncMutex.ts's own header comment for the full story.
  const toPushUp = await withLock('bookmarks', async () => {
    const fresh = await getBookmarks()
    // freshById, NOT the pre-network `localById`: the 2026-08-21 mutex work
    // moved the BASE LIST to a fresh under-lock read but left the DECISIONS
    // on the snapshot taken before the network round-trip. The lock
    // serializes writes; it cannot make a stale comparison correct.
    // Matters most for the r.deleted branch below, whose own comment promises
    // "a re-add always outlives the delete that preceded it" -- a re-add that
    // landed during the round trip was missing from localById, so `!loc` was
    // true and the just-re-added bookmark was deleted anyway.
    const freshById = new Map(fresh.map((b) => [b.id, b]))
    const merged = new Map(freshById)

    for (const r of remote ?? []) {
      if (r.deleted) {
        // Guarded by the same last-write-wins comparison mergeFolders and
        // mergeNotes below already use -- this branch alone used to delete
        // unconditionally, which is a real silent-data-loss path because a
        // WHOLE-DOC bookmark's id is the document's own id (bookmarks.ts:
        // "a whole-doc bookmark, where id === acId"), so it is REUSED every
        // time the same document is bookmarked again. Chain: bookmark AC X,
        // un-bookmark it (remote row -> deleted = true), re-bookmark it
        // while offline or during any transient failure -- syncPushBookmark
        // is fire-and-forget and only logs (syncPush.ts's reportSyncError),
        // so the remote row stays deleted = true. On the next launch this
        // loop deleted the freshly re-added local bookmark, and the
        // `pushUp` filter below skipped it too (a remote row DID exist), so
        // it was never restored either -- guaranteed loss, not a race.
        // Folder items are immune to the same shape only because their ids
        // are a fresh makeId() per add (folders.ts's addManyToFolder).
        //
        // savedAt is the right local side of the comparison: addBookmark
        // stamps a fresh one on every add, so a re-add always outlives the
        // delete that preceded it, while a genuine delete made on ANOTHER
        // device is still newer than this device's untouched copy and is
        // honored exactly as before. Ties go to the delete (`>` on the
        // remote side), matching mergeFolders/mergeNotes.
        const loc = freshById.get(r.id)
        if (!loc || new Date(r.updated_at) > new Date(loc.savedAt)) merged.delete(r.id)
        continue
      }
      // A row this device deleted but could not push yet must not be written
      // back just because the server still shows it as live.
      if (pendingDeleted.has(r.id)) continue
      if (!freshById.has(r.id)) {
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
    // Was `!remote.some(r => r.id === loc.id)` -- local-only rows only. A
    // bookmark the loop above just decided to KEEP against a stale remote
    // delete has a remote row, so it fell through both halves: not deleted
    // locally any more, but never re-uploaded either, leaving the cloud copy
    // permanently marked deleted until the user happened to touch it again.
    // push_bookmark's ON CONFLICT sets deleted = false, so re-pushing it is
    // exactly the resurrection this case needs.
    const pushUp = fresh.filter((loc) => {
      const r = (remote ?? []).find((x) => x.id === loc.id)
      if (!r) return true
      return r.deleted && !(new Date(r.updated_at) > new Date(loc.savedAt))
    })
    await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify([...merged.values()]))
    return pushUp
  })
  for (const b of toPushUp) await syncPushBookmark(b)
}

async function mergeFolders(userId: string) {
  // Only the remote fetch here now. The pre-network getFolders() read that
  // used to sit alongside it fed `localById`, which is gone -- the merge
  // reads fresh inside the lock instead (see below), so a second read out
  // here would only be a snapshot guaranteed to be staler.
  const remote = await pullAllPages((f, t) =>
    supabase.from('synced_folders').select('*').eq('user_id', userId).order('id').range(f, t), 'folders')
  // withLock('folders', ...) -- the SAME lock key folders.ts's own
  // createFolder/reorderFolders/renameFolder/markFolderShared/deleteFolder/
  // addManyToFolder/removeFromFolder/etc now use (one shared domain for
  // both the folders and folder-items keys), so this merge and a
  // concurrent local write can never race. Reads fresh right before writing,
  // AND decides against that same fresh read -- the 2026-08-21 mutex work
  // moved the base list but left the decision on the pre-network snapshot,
  // which is the hole this closes. See asyncMutex.ts's own header comment.
  const toPushUp = await withLock('folders', async () => {
    const fresh = await getFolders()
    const freshById = new Map(fresh.map((f) => [f.id, f]))
    const merged = new Map(freshById)

    for (const r of remote ?? []) {
      // freshById, NOT the pre-network `localById`. The lock serializes the
      // WRITES, but the remoteNewer DECISION was still being made against a
      // snapshot taken before the round trip -- so a local edit that landed
      // during that window was invisible here, and its newer updated_at was
      // compared as if it were the old one. A rename, a drag-reorder, or a
      // markFolderShared() completed mid-pull would be judged "remote is
      // newer" and overwritten with the server's older copy.
      const loc = freshById.get(r.id)
      const remoteNewer = !loc || new Date(r.updated_at) > new Date(loc.updated_at)
      if (r.deleted) {
        if (remoteNewer) merged.delete(r.id)
        continue
      }
      if (remoteNewer) {
        // Carries `shared` forward from the existing local value -- synced_folders
        // has no boolean "shared" column of its own (see the Folder.shared
        // comment in folders.ts), so a remote-newer update must not silently
        // drop it, only sort_order and the other real columns actually come
        // from `r`. Also OR'd with `r.share_token != null`: on a folder pulled
        // fresh (new device, reinstall, cleared storage -- `loc` undefined or
        // stale-false), the local flag alone would come back false even though
        // the folder genuinely IS shared, silently downgrading every later
        // add/remove on it to a non-force push (wrong subscription-tier check,
        // and skippable by the personal Back-up & Sync toggle) -- collaborators
        // would stop seeing this device's edits with no error anywhere. Never
        // goes the other way (share_token is "deliberately never unset by
        // unsharing" per that same comment, so this can't spuriously flip an
        // unshared folder back to shared).
        merged.set(r.id, {
          id: r.id,
          name: r.name,
          created_at: r.created_at,
          updated_at: r.updated_at,
          sort_order: r.sort_order ?? undefined,
          shared: loc?.shared || !!r.share_token,
        })
      }
    }
    const pushUp = fresh.filter((loc) => {
      const r = (remote ?? []).find((x) => x.id === loc.id)
      return !r || new Date(loc.updated_at) > new Date(r.updated_at)
    })
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...merged.values()]))
    return pushUp
  })
  for (const f of toPushUp) await syncPushFolder(f)
}

async function mergeFolderItems(userId: string, pendingDeleted: Set<string> = new Set()) {
  // Was .eq('user_id', userId) -- only ever pulled items THIS account
  // authored, so a collaborator's item in a folder this account owns was
  // never even fetched, regardless of what RLS allows. Fetch everything RLS
  // grants (own-folder items of any author + joined-folder items of any
  // author), then scope client-side to just this account's OWN local
  // folders -- a folder merely joined as a collaborator is intentionally
  // left out of the local cache entirely; that experience is served purely
  // remotely by sharedFolders.ts's getSharedFolder*Items, unchanged by this.
  // Fully paginated now, not just a raised cap: the old `.range(0, 1999)`
  // was still a ceiling, and this query is NOT scoped by user_id -- it
  // returns every RLS-visible row, shared-folder items included, so it hits
  // a limit sooner than a per-account query would (see
  // gotcha_postgrest_1000_row_cap in memory).
  const [ownFolders, remote, local] = await Promise.all([
    getFolders(),
    pullAllPages((f, t) => supabase.from('synced_folder_items').select('*').order('id').range(f, t), 'folder items'),
    getFolderItems(),
  ])
  const ownFolderIds = new Set(ownFolders.map((f) => f.id))
  const relevantRemote = (remote ?? []).filter((r) => ownFolderIds.has(r.folder_id))

  // withLock('folders', ...) -- same shared domain as mergeFolders above
  // and every folders.ts write. Reads fresh right before writing, and the
  // "already exists locally" decision reads that same fresh map -- not the
  // pre-network snapshot it used until 2026-09-04.
  const toPushUp = await withLock('folders', async () => {
    const fresh = await getFolderItems()
    // freshById, NOT the pre-network `localById`: the 2026-08-21 mutex work
    // moved the BASE LIST to a fresh under-lock read but left the DECISIONS
    // on the snapshot taken before the network round-trip. The lock
    // serializes writes; it cannot make a stale comparison correct.
    const freshById = new Map(fresh.map((i) => [i.id, i]))
    const merged = new Map(freshById)

    for (const r of relevantRemote) {
      if (r.deleted) {
        merged.delete(r.id)
        continue
      }
      // A row this device deleted but could not push yet must not be written
      // back just because the server still shows it as live.
      if (pendingDeleted.has(r.id)) continue
      if (!freshById.has(r.id)) {
        merged.set(r.id, {
          id: r.id,
          folder_id: r.folder_id,
          item_type: r.item_type,
          item_id: r.item_id,
          added_at: r.added_at,
          // Tags rows this account didn't author -- see FolderItem.authorId.
          // Own-authored rows (r.user_id === userId) stay untagged so they
          // still push up normally if this device somehow lost them locally.
          ...(r.user_id !== userId ? { authorId: r.user_id } : {}),
        })
      }
    }
    // Never push up a row that isn't this account's own -- see
    // FolderItem.authorId's comment for why that would duplicate it remotely.
    // Rows the server has already permanently refused (lost write access to a
    // shared folder) are skipped while their cooldown holds -- otherwise this
    // filter re-queues them every single cycle, since "not present remotely"
    // is a condition a permanently-denied row can never stop satisfying. See
    // syncPush.ts's BLOCKED_ITEMS_KEY comment.
    const blocked = await blockedFolderItemIds()
    const pushUp = fresh.filter(
      (loc) => !loc.authorId && !relevantRemote.some((r) => r.id === loc.id) && !blocked.has(loc.id)
    )
    await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify([...merged.values()]))
    return pushUp
  })
  await syncPushFolderItems(toPushUp)
}

async function mergeNotes(userId: string, pendingDeleted: Set<string> = new Set()) {
  const [ownRemote, local, ownFolders] = await Promise.all([
    pullAllPages((f, t) => supabase.from('synced_notes').select('*').eq('user_id', userId).order('id').range(f, t), 'notes'),
    getNotes(),
    getFolders(),
  ])

  // Same gap as mergeFolderItems: a collaborator's OWN note, placed into a
  // folder THIS account owns, is authored under the collaborator's user_id
  // -- the plain .eq('user_id', userId) fetch above would never see it. Find
  // it via the folder_items pointer instead (item_type='note' in one of
  // this account's own folders), same join folder/shared/[id].tsx already
  // uses for the read-only collaborator view, then fetch those specific
  // notes regardless of who authored them -- owners_manage_shared_notes now
  // allows exactly this read.
  const ownFolderIds = ownFolders.map((f) => f.id)
  const noteItemRows = ownFolderIds.length
    ? mustPull(await supabase.from('synced_folder_items').select('item_id').eq('item_type', 'note').in('folder_id', ownFolderIds).eq('deleted', false), 'shared note pointers')
    : ([] as { item_id: string }[])
  const foreignNoteIds = [...new Set((noteItemRows ?? []).map((r) => r.item_id))]
    .filter((id) => !(ownRemote ?? []).some((n) => n.id === id))
  const foreignRemote = foreignNoteIds.length
    ? mustPull(await supabase.from('synced_notes').select('*').in('id', foreignNoteIds), 'shared notes')
    : ([] as any[])

  const remote = [...(ownRemote ?? []), ...(foreignRemote ?? [])]
  const foreignIds = new Set((foreignRemote ?? []).map((n) => n.id))

  // Routed through updateNotes (the SAME 'notes' lock domain notes.tsx/
  // folder/[id].tsx's own edits now use) rather than a raw getNotes-then-
  // saveNotes pair -- that's the actual fix for the clobber race: the
  // mutator below runs against a truly fresh read taken under the lock,
  // immediately before the write, so a local note edit landing at the same
  // moment either fully happens before this merge starts or fully after it
  // finishes, never silently in between. The remoteNewer decision reads the
  // SAME fresh list the mutator was handed -- it used the pre-network
  // snapshot until 2026-09-04. toPushUp is captured via
  // this closure since updateNotes's mutator only returns the next array.
  let toPushUp: Note[] = []
  await updateNotes((fresh) => {
    // freshById, NOT the pre-network `localById`: the 2026-08-21 mutex work
    // moved the BASE LIST to a fresh under-lock read but left the DECISIONS
    // on the snapshot taken before the network round-trip. The lock
    // serializes writes; it cannot make a stale comparison correct.
    // Worst of the three: pullAndMergeAll runs unawaited at launch
    // (applyRemoteSyncPreference), so a note the user was editing during the
    // pull had its newer updated_at invisible here and the server's OLDER
    // body was written over the text that had just been saved.
    const freshById = new Map(fresh.map((n) => [n.id, n]))
    const merged = new Map(freshById)
    for (const r of remote) {
      // A note this device deleted but could not push yet must not be written
      // back just because the server still shows it as live.
      if (pendingDeleted.has(r.id)) continue
      const loc = freshById.get(r.id)
      const remoteNewer = !loc || new Date(r.updated_at) > new Date(loc.updated_at)
      if (r.deleted) {
        if (remoteNewer) merged.delete(r.id)
        continue
      }
      if (remoteNewer) {
        merged.set(r.id, {
          id: r.id,
          title: r.title,
          body: r.body,
          linked_ac: r.linked_ac,
          updated_at: r.updated_at,
          // See Note.authorId -- tags a collaborator's note so notes.tsx
          // routes edits through updateSharedNote instead of syncPushNote.
          ...(foreignIds.has(r.id) ? { authorId: r.user_id } : {}),
        })
      }
    }
    // Foreign-authored notes are never pushed up under this account's own
    // user_id (see notes.tsx's handleSave, which routes edits to those
    // through updateSharedNote instead) -- excluding them here too,
    // defensively, in case a future caller ever re-pushes the full local
    // list the way enableSync does for folder items.
    toPushUp = fresh.filter((loc) => {
      if (isSeedNote(loc.id) || foreignIds.has(loc.id)) return false
      const r = remote.find((x) => x.id === loc.id)
      return !r || new Date(loc.updated_at) > new Date(r.updated_at)
    })
    return [...merged.values()]
  })
  for (const n of toPushUp) await syncPushNote(n)
}

// A lighter, single-folder version of mergeFolderItems/mergeNotes above --
// safe to call far more often (every time folder/[id].tsx focuses), unlike
// pullAndMergeAll which touches every bookmark, folder, and note the account
// has. Exists so a collaborator's write shows up for the owner the moment
// they open that one folder, not only after the next full sync (app
// launch, or toggling Back-up & Sync off/on). Deliberately not merged into
// mergeFolderItems itself -- that one intentionally scans every owned
// folder at once; this one is scoped to exactly the folder screen asking.
export async function syncFolderFromCloud(folderId: string, userId: string): Promise<void> {
  const [{ data: remote }, local] = await Promise.all([
    supabase.from('synced_folder_items').select('*').eq('folder_id', folderId),
    getFolderItems(),
  ])
  const byId = new Map(local.map((i) => [i.id, i]))
  // Decide what remote dictates against this ORIGINAL snapshot (unchanged
  // decision logic) -- called far more often than pullAndMergeAll's
  // mergeFolderItems (every folder screen focus, not just app launch), so
  // this was actually the MOST exposed instance of the sync-clobber race
  // found in the 2026-08-21 sweep, not a lesser copy of it. Same fix: apply
  // these decisions onto a freshly-read base, under the 'folders' lock,
  // immediately before writing -- not onto the stale `local` snapshot
  // above, which used to be what actually got written.
  const idsToDelete = new Set<string>()
  const itemsToAdd: FolderItem[] = []
  for (const r of remote ?? []) {
    if (r.deleted) {
      if (byId.has(r.id)) idsToDelete.add(r.id)
      continue
    }
    if (!byId.has(r.id)) {
      itemsToAdd.push({
        id: r.id,
        folder_id: r.folder_id,
        item_type: r.item_type,
        item_id: r.item_id,
        added_at: r.added_at,
        ...(r.user_id !== userId ? { authorId: r.user_id } : {}),
      })
    }
  }
  let merged: FolderItem[] = local
  if (idsToDelete.size || itemsToAdd.length) {
    merged = await withLock('folders', async () => {
      // Splice just this folder's rows back into the full local list -- other
      // folders' items aren't part of `local` restricted here, they came
      // straight from the unfiltered getFolderItems() above.
      const fresh = await getFolderItems()
      // Keyed by id, not concatenated. `itemsToAdd` is computed from the
      // pre-lock snapshot, so a row another pass already wrote into `fresh`
      // would otherwise be appended a SECOND time with the same id.
      // folder/[id].tsx calls load() from four independent triggers -- screen
      // focus, a 45s interval, the realtime subscription, and AppState
      // foreground -- with no in-flight guard, so two overlapping
      // syncFolderFromCloud passes are ordinary, not exotic. The lock
      // serializes the writes but cannot dedupe an append. mergeFolderItems
      // is immune only because it builds a Map; this path did not.
      const byIdNext = new Map(fresh.filter((i) => !idsToDelete.has(i.id)).map((i) => [i.id, i]))
      for (const i of itemsToAdd) byIdNext.set(i.id, i)
      const next = [...byIdNext.values()]
      await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify(next))
      return next
    })
  }

  const noteIds = merged.filter((i) => i.folder_id === folderId && i.item_type === 'note').map((i) => i.item_id)
  if (!noteIds.length) return

  const [{ data: remoteNotes }, localNotes] = await Promise.all([
    supabase.from('synced_notes').select('*').in('id', noteIds),
    getNotes(),
  ])
  const noteById = new Map(localNotes.map((n) => [n.id, n]))
  // Same pattern as above: decide against the original snapshot, apply onto
  // a fresh read under the 'notes' lock.
  const noteIdsToDelete = new Set<string>()
  const notesToUpsert: Note[] = []
  for (const r of remoteNotes ?? []) {
    const loc = noteById.get(r.id)
    const remoteNewer = !loc || new Date(r.updated_at) > new Date(loc.updated_at)
    if (r.deleted) {
      if (loc && remoteNewer) noteIdsToDelete.add(r.id)
      continue
    }
    if (remoteNewer) {
      notesToUpsert.push({
        id: r.id,
        title: r.title,
        body: r.body,
        linked_ac: r.linked_ac,
        updated_at: r.updated_at,
        ...(r.user_id !== userId ? { authorId: r.user_id } : {}),
      })
    }
  }
  if (noteIdsToDelete.size || notesToUpsert.length) {
    await updateNotes((fresh) => {
      const freshById = new Map(fresh.map((n) => [n.id, n]))
      for (const id of noteIdsToDelete) freshById.delete(id)
      for (const n of notesToUpsert) freshById.set(n.id, n)
      return [...freshById.values()]
    })
  }
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
    // push in that case and pull only. Reuses localDataBelongsTo (not a
    // second copy of the same owner-compare) so this inherits
    // claimDeviceIfMismatched's own same-person-different-id reconciliation
    // for free -- that already ran earlier in the same sign-in flow
    // (context/auth.tsx), so by the time this runs the tag is already
    // correctly resolved for the CURRENT session.
    const localBelongsToThisUser = await localDataBelongsTo(userId)

    if (localBelongsToThisUser) {
      const [bookmarks, folders, folderItems, notes] = await Promise.all([
        getBookmarks(),
        getFolders(),
        getFolderItems(),
        getNotes(),
      ])
      // Excludes anything tagged authorId -- a collaborator's item/note
      // merged into this account's local cache (see mergeFolderItems/
      // mergeNotes above). Re-pushing those here would upsert under this
      // account's own user_id on a (user_id, id) conflict key that doesn't
      // match the original row, creating a duplicate server-side instead of
      // updating it. See FolderItem.authorId / Note.authorId.
      await Promise.all([
        ...bookmarks.map((b) => syncPushBookmark(b)),
        ...folders.map((f) => syncPushFolder(f)),
        syncPushFolderItems(folderItems.filter((i) => !i.authorId)),
        ...notes.filter((n) => !isSeedNote(n.id) && !n.authorId).map((n) => syncPushNote(n)),
        // Seed the account with THIS device's settings on the way up. Without
        // it, a user who has spent a year setting up their phone and only now
        // turns sync on would push their library but not their preferences,
        // then pull nothing back -- and would reasonably read that as sync
        // having ignored half of what they set. Same ownership guard as
        // everything else in this block: only runs when the local data is
        // genuinely this account's.
        pushAllAppSettings(),
      ])
    }
    // Always pull, both paths: this account's own cloud data belongs on this
    // device either way, and on the mismatch path it's the whole point --
    // the new user still gets everything of theirs without giving anything up.
    await pullAndMergeAll(userId)
    // Claim ownership only after a clean push+pull, so a failure can't leave
    // the tag pointing at an account whose data never actually landed.
    //
    // No email argument on purpose -- enableSync is reached from a UI toggle
    // and from applyRemoteSyncPreference, neither of which carries the
    // session's email, and claimDeviceIfMismatched has already stamped the
    // right one for this session by the time any of them run.
    // setSyncOwner itself now preserves the stored email for the same userId
    // rather than nulling it (see its own comment) -- this bare call is what
    // used to erase it on every single sync enable.
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
  // `.catch()` alone was dead code here: supabase.auth.updateUser RESOLVES
  // {data, error} and does not reject, so a failed cross-device preference
  // write was completely invisible. Still deliberately non-blocking (see
  // above -- a backup that already succeeded must not be rolled back), but it
  // is now REPORTED, because this comment's claim that
  // applyRemoteSyncPreference "will reconcile it" is NOT true in this
  // direction: on the next launch that function sees remote=false /
  // local=true and resolves it by calling disableSync(), silently reversing
  // the user's intent and stopping their backup. Which side should win is a
  // product call -- logged for RC rather than guessed at here.
  supabase.auth.updateUser({ data: { sync_enabled: true } })
    .then(({ error }) => reportSyncError('sync preference enable', error))
    .catch(() => {})
}

export async function disableSync(): Promise<void> {
  await AsyncStorage.setItem(SYNC_ENABLED_KEY, 'false')
  // The result was discarded entirely, and updateUser RESOLVES rather than
  // rejects, so a failed write here was silent too. Deliberately still not
  // thrown: two of this function's five call sites are the UNAWAITED
  // auto-disable-on-lapse paths in saved.tsx/notes.tsx, where throwing would
  // only turn a silent failure into an unhandled rejection.
  const { error } = await supabase.auth.updateUser({ data: { sync_enabled: false } })
  reportSyncError('sync preference disable', error)
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
  } else if (remoteSyncEnabled === true && local) {
    // Steady state: sync already on, both sides agree -- the common case
    // on every normal launch. Nothing reconciled a stuck row here before:
    // every syncPush* call is fire-and-forget (syncPush.ts), so a
    // transient network failure at push time leaves that one item
    // permanently un-backed-up (logged to console+Sentry only) until the
    // user happens to edit that same item again or manually toggles sync
    // off/on -- the ONLY path that ever re-ran the toPushUp reconciliation
    // below, via the mismatch branch above. Confirmed live in the B34
    // readiness sweep. pullAndMergeAll's own per-section toPushUp already
    // implements exactly "push whatever's local-only" (used by enableSync
    // above), so reuse it here instead of a second copy of that logic.
    // Fire-and-forget + swallowed, matching this function's own existing
    // pattern for its unawaited caller (auth.tsx) -- a transient failure
    // here just means the next launch tries again, not a user-facing error.
    pullAndMergeAll(userId).catch(() => {})
  }
}
