import { getFolderItems } from '@/lib/folders'
import { getBookmarks } from '@/lib/bookmarks'
import { getNotes } from '@/lib/notes'

// Real-device/TestFlight report, 2026-08-21: "the folder count says six, but
// there's only four items in the folder." getFolders.ts's own
// getFolderItemCounts() (still exported from there, still used nowhere in
// THIS file's module graph) just counts every local folder_items row for a
// folder_id with zero filtering -- it counts rows folder/[id].tsx's own
// loadLocal() would never render: a genuinely orphaned row (its AC/note was
// deleted elsewhere, before removeItemFromAllFolders existed to clean it up,
// or before that screen's own network-backed resolution -- see its comment
// on the 2026-08-21 fix -- confirms it's really gone), which inflates the
// raw count forever until the folder is actually opened. The raw count and
// the detail screen's own filtered render simply used two different
// definitions of "how many items are in this folder," and disagreed
// whenever anything failed to resolve.
//
// This file exists separately from folders.ts specifically to avoid a
// folders.ts <-> bookmarks.ts require cycle: bookmarks.ts already imports
// removeItemsFromAllFolders from folders.ts (see that file's own top-of-file
// reasoning, mirrored in syncPush.ts/sharedFolders.ts for the same hazard).
// A resolved count needs to cross-reference the local bookmarks/notes
// stores, so it can't live inside folders.ts itself without folders.ts
// importing back from bookmarks.ts.
export async function getResolvedFolderItemCounts(): Promise<Record<string, number>> {
  const [items, bookmarks, notes] = await Promise.all([getFolderItems(), getBookmarks(), getNotes()])
  const bookmarkIds = new Set(bookmarks.map((b) => b.id))
  const noteIds = new Set(notes.map((n) => n.id))

  const counts: Record<string, number> = {}
  for (const item of items) {
    // Same "does this resolve" rule folder/[id].tsx's loadLocal() uses per
    // item, minus the network fallback that screen also runs -- a purely
    // local, synchronous check is the right tradeoff here since this runs
    // for every folder on list screens (Saved, FolderPicker, FolderSelectSheet),
    // not once for a single open folder. authorId (a collaborator's item on
    // a folder THIS account owns, or this SAME account's own item added from
    // a second device and not yet locally cached) is never treated as
    // missing just because it isn't in this account's own local bookmark/
    // note cache -- see FolderItem.authorId's own comment. Excluding a
    // same-account, not-yet-locally-resolved item here (the one case this
    // local-only check can't tell apart from a real orphan) just means the
    // badge briefly undercounts by a handful until the next sync catches up,
    // which is a far smaller and self-correcting drift than the systematic
    // overcounting this file replaces.
    const resolvesLocally = item.item_type === 'note' ? noteIds.has(item.item_id) : bookmarkIds.has(item.item_id)
    if (resolvesLocally || item.authorId) {
      counts[item.folder_id] = (counts[item.folder_id] ?? 0) + 1
    }
  }
  return counts
}
