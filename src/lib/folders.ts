import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { syncPushFolder, syncPushFolderDelete, syncPushFolderItems, syncPushFolderItemDeletes, syncPushNote } from '@/lib/syncPush'
import { getNotes } from '@/lib/notes'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'

// Revokes sharing entirely: removes every collaborator and invalidates the
// share link (a new one is generated next time the owner shares again). The
// folder itself and its contents are untouched -- this only undoes sharing,
// it's not folder deletion. Lives here (not sharedFolders.ts) so that module
// can safely import folder-reading helpers from this file without creating a
// require cycle -- see getOrCreateShareLink in sharedFolders.ts.
export async function unshareFolder(folderId: string): Promise<void> {
  await supabase.from('folder_collaborators').delete().eq('folder_id', folderId)
  await supabase.from('synced_folders').update({ share_token: null }).eq('id', folderId)
}

const FOLDERS_KEY = '@flyregs/folders'
const FOLDER_ITEMS_KEY = '@flyregs/folder_items'

// Plus and Pro are both capped at this many folders; Premium is unlimited.
// RC, 2026-08-14, direct correction: "my quote has nothing to do with
// folders, h/l, etc. -- ONLY the 'bu/s' feature itself... All of those
// things are supposed to be part of Plus. It's just the bu/s feature that
// gets gated to Pro/Prem." A prior pass (2026-08-11, gotcha_gating_sweep_
// 2026_08_11.md) had moved folder/note/bookmark/highlight CREATION itself
// to Pro on a misreading of that same quote -- reverted here. This constant
// keeps its historical "PRO_" name (matching this codebase's own precedent
// of not renaming a symbol for a name-only change, see enforce_bookmark_
// plus_gate()'s comment) even though Plus now uses the same value -- Pro's
// only real difference is that its folders can also be synced across
// devices via the separate "Back up & sync" toggle (hasProAccess-gated,
// unchanged by this correction).
export const PRO_FOLDER_CAP = 3

export interface Folder {
  id: string
  name: string
  created_at: string
  updated_at: string
  /** True once this folder has been shared at least once. Sharing is a
   * per-folder decision, not a whole-library one -- this flag lets a shared
   * folder's own data keep syncing to the cloud (so collaborators keep
   * seeing it) even when the user has never turned on the separate, global
   * "Back up & sync" toggle for their whole library. See sharedFolders.ts's
   * confirmFolderShared, which sets this once the owner has actually
   * confirmed the invite link was sent (not merely generated -- see
   * getOrCreateShareLink). Deliberately never unset by unsharing -- if they
   * re-share later, the cloud rows are already there, no harm in leaving
   * them. */
  shared?: boolean
  /** User-controlled display order (lower = earlier), set by reorderFolders().
   * Undefined on a folder that's never been touched by the reorder feature --
   * getFolders() falls back to array position for those, which was always the
   * de facto order before this field existed (createFolder always appended). */
  sort_order?: number
}

// 'far'/'aim'/'pcg'/'ad'/'dictionary' item_ids are the section_number/
// paragraph_number/slug/id/slug string each type's own detail route keys
// on (not necessarily a uuid) -- same shape AC ids already had.
export type FolderItemType = 'ac' | 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary' | 'note' | 'cfr49'

export interface FolderItem {
  id: string
  folder_id: string
  item_type: FolderItemType
  item_id: string
  added_at: string
  /** Set only when this row was pulled down from a collaborator on a shared
   * folder THIS account owns (see sync.ts's mergeFolderItems) -- absent for
   * every item this account authored itself, local or synced. Load-bearing
   * for one thing only: every push path (syncPushFolderItems' bulk re-push
   * in particular) must skip rows with this set, never re-upload them under
   * this account's own user_id. That upsert's conflict key is (user_id, id),
   * not id alone, so re-pushing a foreign row creates a second, duplicate
   * row server-side instead of updating the original. */
  authorId?: string
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// ── Folders ───────────────────────────────────────────────────────────────────

// Gotcha, found 2026-08-09 while verifying BB-102: this local store is
// GLOBAL (no per-user namespacing -- see syncOwner.ts's own comment), and
// this function used to serve whatever was cached here to ANY signed-in
// user with zero ownership check. On a shared device, signing into a
// different account still rendered the PREVIOUS account's folders --
// owner-only UI (invite, delete, mode toggle) included -- even though
// server-side RLS was always correctly locked down; this was a pure
// client-side stale-cache read leak. Signed-out (anonymous) browsing is
// deliberately unaffected -- there's no userId to compare against yet, so
// local-first bookmarks/folders keep working exactly as before.
export async function getFolders(): Promise<Folder[]> {
  try {
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
    const raw = await AsyncStorage.getItem(FOLDERS_KEY)
    const folders: Folder[] = raw ? JSON.parse(raw) : []
    // Stable sort -- a folder with no sort_order yet (never touched by
    // reorderFolders or a synced-down remote row) falls back to wherever it
    // already sat in the stored array, which was always the de facto order
    // before this field existed.
    return [...folders].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
  } catch {
    return []
  }
}

// Thrown by createFolder when a folder with the same name (case/whitespace-
// insensitive) already exists, so two folders named e.g. "Training" and
// "training " can't silently coexist and be confused for each other.
export const DUPLICATE_FOLDER_NAME = 'DUPLICATE_FOLDER_NAME'

export async function createFolder(name: string): Promise<Folder> {
  const trimmed = name.trim()
  const folders = await getFolders()
  if (folders.some((f) => f.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(DUPLICATE_FOLDER_NAME)
  }
  const now = new Date().toISOString()
  const nextOrder = folders.reduce((max, f) => Math.max(max, f.sort_order ?? -1), -1) + 1
  const folder: Folder = { id: makeId(), name: trimmed, created_at: now, updated_at: now, sort_order: nextOrder }
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...folders, folder]))
  syncPushFolder(folder)
  return folder
}

// Persists a full new display order after a drag-and-drop reorder in the UI.
// Takes the complete list of folder ids in their new order (not just the
// ones that visually moved) -- moving one folder shifts every folder between
// its old and new position, so "what actually changed" isn't worth computing
// separately from "here's the whole new order."
export async function reorderFolders(orderedIds: string[]): Promise<Folder[]> {
  const folders = await getFolders()
  const byId = new Map(folders.map((f) => [f.id, f]))
  const now = new Date().toISOString()
  const reordered: Folder[] = orderedIds
    .map((id, i): Folder | null => {
      const f = byId.get(id)
      return f ? { ...f, sort_order: i, updated_at: now } : null
    })
    .filter((f): f is Folder => f !== null)
  // Any folder not present in orderedIds (shouldn't normally happen -- the
  // caller reorders the exact list it was given) is kept, appended after,
  // rather than silently dropped.
  const missing = folders.filter((f) => !orderedIds.includes(f.id))
  const next = [...reordered, ...missing]
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(next))
  for (const f of reordered) syncPushFolder(f, f.shared)
  return next
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  const folders = await getFolders()
  if (folders.some((f) => f.id !== id && f.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(DUPLICATE_FOLDER_NAME)
  }
  const updated_at = new Date().toISOString()
  const next = folders.map((f) => (f.id === id ? { ...f, name: trimmed, updated_at } : f))
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(next))
  const renamed = next.find((f) => f.id === id)
  if (renamed) syncPushFolder(renamed, renamed.shared)
}

// Marks a folder as shared locally -- called once by sharedFolders.ts's
// confirmFolderShared, once the owner has actually sent the invite link (not
// merely generated one). See the Folder.shared field comment for why this
// exists.
export async function markFolderShared(folderId: string): Promise<void> {
  const folders = await getFolders()
  const next = folders.map((f) => (f.id === folderId ? { ...f, shared: true } : f))
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(next))
}

export async function deleteFolder(id: string): Promise<void> {
  const [folders, items] = await Promise.all([getFolders(), getFolderItems()])
  const itemsInFolder = items.filter((i) => i.folder_id === id)
  await Promise.all([
    AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.filter((f) => f.id !== id))),
    AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify(items.filter((i) => i.folder_id !== id))),
  ])
  syncPushFolderDelete(id)
  syncPushFolderItemDeletes(itemsInFolder.map((i) => i.id))
  // Deleting a folder should also drop anyone it was shared with -- otherwise
  // stale folder_collaborators rows linger forever with no owning folder.
  unshareFolder(id).catch(() => {})
}

// BB-079, RC real-device beta report: "we need to allow creation of a
// 'duplicate' folder. so user could share same folder w/ diff sets of
// people w/o having to recreate it." The new folder starts as a plain,
// unshared copy of the source's OWN content -- deliberately does NOT
// carry over share_token/collaborators (the whole point is a fresh,
// independently-shareable folder) and skips any item this account didn't
// author itself (a foreign/collaborator-added item on a folder THIS
// account owns -- see FolderItem.authorId -- isn't this account's content
// to hand to a brand new set of people without the original author's say).
export async function duplicateFolder(id: string): Promise<Folder> {
  const [folders, items] = await Promise.all([getFolders(), getItemsInFolder(id)])
  const source = folders.find((f) => f.id === id)
  if (!source) throw new Error('Folder not found')

  let name = `${source.name} Copy`
  let n = 2
  while (folders.some((f) => f.name.trim().toLowerCase() === name.toLowerCase())) {
    name = `${source.name} Copy ${n}`
    n++
  }
  const copy = await createFolder(name)

  const byType = new Map<FolderItemType, string[]>()
  for (const item of items) {
    if (item.authorId) continue
    const arr = byType.get(item.item_type) ?? []
    arr.push(item.item_id)
    byType.set(item.item_type, arr)
  }
  for (const [type, itemIds] of byType) {
    await addManyToFolder(copy.id, type, itemIds)
  }
  return copy
}

// ── Folder items ──────────────────────────────────────────────────────────────

export async function getFolderItems(): Promise<FolderItem[]> {
  try {
    // Same account-mismatch guard as getFolders() above -- these two stores
    // are always read/written together.
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
    const raw = await AsyncStorage.getItem(FOLDER_ITEMS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function getItemsInFolder(folderId: string): Promise<FolderItem[]> {
  const items = await getFolderItems()
  return items.filter((i) => i.folder_id === folderId)
}

export async function getFoldersForItem(itemType: FolderItemType, itemId: string): Promise<string[]> {
  const items = await getFolderItems()
  return items
    .filter((i) => i.item_type === itemType && i.item_id === itemId)
    .map((i) => i.folder_id)
}

export async function addToFolder(
  folderId: string,
  itemType: FolderItemType,
  itemId: string
): Promise<void> {
  return addManyToFolder(folderId, itemType, [itemId])
}

// Adds several items to a folder in one read-modify-write. Calling addToFolder
// in a Promise.all loop is unsafe — each call reads the same pre-write snapshot
// of AsyncStorage, so concurrent writes clobber each other and only the last
// item survives. This does the read once, adds everything, writes once.
export async function addManyToFolder(
  folderId: string,
  itemType: FolderItemType,
  itemIds: string[]
): Promise<void> {
  const [items, folders] = await Promise.all([getFolderItems(), getFolders()])
  const existing = new Set(
    items
      .filter((i) => i.folder_id === folderId && i.item_type === itemType)
      .map((i) => i.item_id)
  )
  const now = new Date().toISOString()
  const newItems: FolderItem[] = itemIds
    .filter((itemId) => !existing.has(itemId))
    .map((itemId) => ({
      id: makeId(),
      folder_id: folderId,
      item_type: itemType,
      item_id: itemId,
      added_at: now,
    }))
  if (newItems.length === 0) return
  await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify([...items, ...newItems]))
  const isShared = folders.find((f) => f.id === folderId)?.shared ?? false
  syncPushFolderItems(newItems, isShared)
  // A shared folder's notes need their actual content in the cloud too, not
  // just the item pointer -- unlike ACs (resolved against the public
  // advisory_circulars table for anyone), a note's title/body only exists in
  // synced_notes, which is otherwise gated on the global sync toggle.
  if (isShared && itemType === 'note' && newItems.length) {
    const notes = await getNotes()
    const noteMap = new Map(notes.map((n) => [n.id, n]))
    for (const item of newItems) {
      const note = noteMap.get(item.item_id)
      if (note) syncPushNote(note, true)
    }
  }
}

export async function removeFromFolder(
  folderId: string,
  itemType: FolderItemType,
  itemId: string
): Promise<void> {
  const [items, folders] = await Promise.all([getFolderItems(), getFolders()])
  const removed = items.filter(
    (i) => i.folder_id === folderId && i.item_type === itemType && i.item_id === itemId
  )
  await AsyncStorage.setItem(
    FOLDER_ITEMS_KEY,
    JSON.stringify(items.filter((i) => !removed.some((r) => r.id === i.id)))
  )
  const isShared = folders.find((f) => f.id === folderId)?.shared ?? false
  syncPushFolderItemDeletes(removed.map((i) => i.id), isShared)
}

// Removes several items from one folder in a single read-modify-write — same
// race the addManyToFolder comment above describes: calling removeFromFolder
// in a Promise.all loop is unsafe because each call reads the same pre-write
// AsyncStorage snapshot, so concurrent writes clobber each other and only the
// last removal survives.
export async function removeManyFromFolder(
  folderId: string,
  entries: { itemType: FolderItemType; itemId: string }[]
): Promise<void> {
  if (!entries.length) return
  const [items, folders] = await Promise.all([getFolderItems(), getFolders()])
  const toRemove = new Set(entries.map((e) => `${e.itemType}:${e.itemId}`))
  const removed = items.filter((i) => i.folder_id === folderId && toRemove.has(`${i.item_type}:${i.item_id}`))
  if (!removed.length) return
  const removedIds = new Set(removed.map((r) => r.id))
  await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify(items.filter((i) => !removedIds.has(i.id))))
  const isShared = folders.find((f) => f.id === folderId)?.shared ?? false
  syncPushFolderItemDeletes(removed.map((i) => i.id), isShared)
}

// Removes one item from EVERY folder it's in — called whenever the underlying
// AC bookmark or note is itself deleted. Without this, a folder_item row for
// a since-unbookmarked/deleted item lingers forever: getFolderItemCounts()
// still counts it (inflating the folder's shown count) while the folder
// detail screen silently drops it from the list (its bookmark/note lookup
// fails), producing a folder that claims N items but only renders fewer.
export async function removeItemFromAllFolders(itemType: FolderItemType, itemId: string): Promise<void> {
  return removeItemsFromAllFolders(itemType, [itemId])
}

// Batched form — one read-modify-write for several item ids at once. Callers
// removing multiple bookmarks/notes together (e.g. a multi-select bulk
// delete) MUST use this instead of Promise.all-ing single-id calls, which
// races on the same AsyncStorage snapshot and silently drops all but the
// last removal (see addManyToFolder above for the same class of bug).
export async function removeItemsFromAllFolders(itemType: FolderItemType, itemIds: string[]): Promise<void> {
  if (!itemIds.length) return
  const idSet = new Set(itemIds)
  const [items, folders] = await Promise.all([getFolderItems(), getFolders()])
  const removed = items.filter((i) => i.item_type === itemType && idSet.has(i.item_id))
  if (!removed.length) return
  const removedIds = new Set(removed.map((r) => r.id))
  await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify(items.filter((i) => !removedIds.has(i.id))))
  // Removed items can span both shared and unshared folders in one call --
  // split so only the shared folders' rows force-push past the global toggle.
  const sharedFolderIds = new Set(folders.filter((f) => f.shared).map((f) => f.id))
  const sharedRemoved = removed.filter((i) => sharedFolderIds.has(i.folder_id))
  const unsharedRemoved = removed.filter((i) => !sharedFolderIds.has(i.folder_id))
  if (sharedRemoved.length) syncPushFolderItemDeletes(sharedRemoved.map((i) => i.id), true)
  if (unsharedRemoved.length) syncPushFolderItemDeletes(unsharedRemoved.map((i) => i.id))
}

/** Returns a map of folderId → item count, useful for rendering folder cards. */
export async function getFolderItemCounts(): Promise<Record<string, number>> {
  const items = await getFolderItems()
  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.folder_id] = (counts[item.folder_id] ?? 0) + 1
  }
  return counts
}
