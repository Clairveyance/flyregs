import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncPushBookmark, syncPushBookmarkDeletes } from '@/lib/syncPush'
import { removeItemsFromAllFolders, FolderItemType } from '@/lib/folders'

const KEY = '@flyregs/bookmarks'

export interface BookmarkAC {
  id: string
  /** Absent means 'ac' — every bookmark saved before FAR/AIM/P-CG/AD
   * whole-document bookmarking existed (2026-07-25) has no itemType field at
   * all, so treat a missing value as 'ac' everywhere instead of migrating
   * old rows. Highlights (blockText set) are always itemType 'ac' — the
   * other types don't have character-level highlighting yet. */
  itemType?: FolderItemType
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  savedAt: string
  /** Present only for a "highlight" — a bookmark scoped to one block within
   * the AC rather than the whole document. `id` here is a freshly generated
   * value, NOT the AC's own id (unlike a whole-doc bookmark, where id ===
   * acId) — that's what lets a whole-doc bookmark and any number of
   * highlights coexist for the same AC without id collisions. `acId` is what
   * actually points back to the bookmarked AC. */
  acId?: string
  blockKind?: 'section' | 'item' | 'para'
  blockLabel?: string | null
  blockSnippet?: string
  /** Content snapshot (acFormat.ts's blockText()) used to re-locate the same
   * block after the AC is re-parsed — block ids are sequential counters
   * re-minted on every parse, never stable across revisions. */
  blockText?: string
}

/** Bookmark's own itemType, defaulting missing/legacy rows to 'ac'. */
export function bookmarkItemType(b: Pick<BookmarkAC, 'itemType'>): FolderItemType {
  return b.itemType ?? 'ac'
}

// Resolves the REAL underlying AC id for any bookmark, highlight or not --
// use this before ever building a share link from a BookmarkAC. Passing
// `item.id` directly (a highlight's own synthetic id, not a real
// advisory_circulars.id) produced a share link the recipient's app could
// never resolve, landing on a real "AC not found" screen.
export function resolveBookmarkACId(item: BookmarkAC): string {
  return item.acId ?? item.id
}

// Single source of truth for "where does tapping this bookmark go" — used by
// Saved, Recents, and Offline so a FAR/AIM/P-CG/AD whole-doc bookmark doesn't
// silently mis-route to /ac/<section_number> (which 404s, since that's not a
// real advisory_circulars.id). Highlights/jump-targets are AC-only (see
// BookmarkAC's own comment), so only the 'ac' branch needs the hlId param.
export function routeForBookmark(item: BookmarkAC, opts?: { hlId?: string }): string {
  const type = bookmarkItemType(item)
  if (type === 'ac') {
    const acId = resolveBookmarkACId(item)
    return opts?.hlId ? `/ac/${acId}?hlId=${encodeURIComponent(opts.hlId)}` : `/ac/${acId}`
  }
  // A non-AC bookmark carrying blockText was saved from a Study Mode
  // flashcard and knows which passage it came from -- pass it through so the
  // detail screen highlights and scrolls to that spot (see each screen's own
  // `hl` param handling) instead of opening at the top.
  const hl = item.blockText ? `?hl=${encodeURIComponent(item.blockText)}` : ''
  if (type === 'far') return `/far/${item.id}${hl}`
  if (type === 'aim') return `/aim/${item.id}${hl}`
  if (type === 'pcg') return `/pcg/${item.id}${hl}`
  if (type === 'ad') return `/ad/${item.id}${hl}`
  // LOI bookmarks store the LOI's own slug as `id` (see loi/[slug].tsx's
  // toggleBookmark call), matching /loi/[slug]'s route param directly --
  // was missing entirely, so a synced LOI bookmark silently mis-routed to
  // /ac/<slug> (a real AC lookup miss) before this fix.
  if (type === 'loi') return `/loi/${item.id}`
  // Dictionary bookmarks store the term's own slug as `id`, matching
  // /dictionary/[slug]'s route param -- same pattern as loi above.
  if (type === 'dictionary') return `/dictionary/${item.id}`
  return `/ac/${item.id}` // 'note' never reaches here — notes aren't bookmarks
}

export async function getBookmarks(): Promise<BookmarkAC[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function isBookmarked(id: string): Promise<boolean> {
  const list = await getBookmarks()
  return list.some((b) => b.id === id)
}

export async function addBookmark(ac: Omit<BookmarkAC, 'savedAt'>) {
  const list = await getBookmarks()
  if (list.some((b) => b.id === ac.id)) return
  const bookmark = { ...ac, savedAt: new Date().toISOString() }
  await AsyncStorage.setItem(KEY, JSON.stringify([bookmark, ...list]))
  syncPushBookmark(bookmark)
}

// Ensures a bookmark exists for each given AC in one read-modify-write, only
// inserting ones not already present. Used when an AC is added to a folder
// from a source that isn't itself the bookmarks list (Recents, Offline
// downloads) — the folder-detail screen resolves an 'ac' folder item's
// display data by looking it up in bookmarks (that's where title/date/office
// are stored for offline-first rendering), so without a backing bookmark the
// item would silently vanish from the folder view, and folder/[id].tsx's
// orphaned-item self-heal would then permanently delete the folder_item,
// mistaking "not bookmarked" for "target no longer exists." See
// flyregs_gotchas.md for the 2026-07-12 bug this fixes.
export async function addManyBookmarks(acs: Omit<BookmarkAC, 'savedAt'>[]) {
  if (acs.length === 0) return
  const list = await getBookmarks()
  const existing = new Set(list.map((b) => b.id))
  const now = new Date().toISOString()
  const toAdd = acs.filter((ac) => !existing.has(ac.id)).map((ac) => ({ ...ac, savedAt: now }))
  if (toAdd.length === 0) return
  await AsyncStorage.setItem(KEY, JSON.stringify([...toAdd, ...list]))
  toAdd.forEach(syncPushBookmark)
}

export async function removeBookmark(id: string) {
  return removeManyBookmarks([id])
}

// Removes several bookmarks in one read-modify-write. Calling removeBookmark in
// a Promise.all loop is unsafe — each call reads the same pre-write snapshot of
// AsyncStorage, so concurrent writes clobber each other and only the last
// removal survives. This does the read once, removes everything, writes once.
export async function removeManyBookmarks(ids: string[]) {
  const list = await getBookmarks()
  const idSet = new Set(ids)
  const removed = list.filter((b) => idSet.has(b.id))
  await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((b) => !idSet.has(b.id))))
  syncPushBookmarkDeletes(ids)
  // A removed bookmark may still be referenced by one or more folders — drop
  // those references too, or the folder's item count silently drifts ahead
  // of what it actually renders (see folders.ts's removeItemsFromAllFolders).
  // Removed ids can span multiple content types in one call (e.g. a
  // multi-select bulk delete in Saved), so group by each bookmark's own
  // itemType rather than assuming everything being removed is an 'ac'.
  const byType = new Map<FolderItemType, string[]>()
  for (const b of removed) {
    const t = bookmarkItemType(b)
    byType.set(t, [...(byType.get(t) ?? []), b.id])
  }
  await Promise.all([...byType.entries()].map(([t, tIds]) => removeItemsFromAllFolders(t, tIds)))
}

/** Toggle and return the new bookmarked state. */
export async function toggleBookmark(ac: Omit<BookmarkAC, 'savedAt'>): Promise<boolean> {
  if (await isBookmarked(ac.id)) {
    await removeBookmark(ac.id)
    return false
  }
  await addBookmark(ac)
  return true
}

// ── Highlights (section-scoped bookmarks) ───────────────────────────────────
// Built on the exact same storage/sync as whole-doc bookmarks above — a
// highlight is just a BookmarkAC row with acId/blockText set and a generated
// (non-AC) id, so it shows up in the same Saved list, the same sync pipeline,
// and inherits the same Pro/Premium gating with no separate code path.

export async function getHighlightsForAC(acId: string): Promise<BookmarkAC[]> {
  const list = await getBookmarks()
  return list.filter((b) => b.acId === acId && b.blockText)
}

export async function findHighlight(acId: string, blockText: string): Promise<BookmarkAC | undefined> {
  const list = await getBookmarks()
  return list.find((b) => b.acId === acId && b.blockText === blockText)
}

export async function addHighlight(h: {
  acId: string
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  blockKind: 'section' | 'item' | 'para'
  blockLabel: string | null
  blockSnippet: string
  blockText: string
}): Promise<BookmarkAC> {
  const id = `${h.acId}-hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const list = await getBookmarks()
  const bookmark: BookmarkAC = { ...h, id, savedAt: new Date().toISOString() }
  await AsyncStorage.setItem(KEY, JSON.stringify([bookmark, ...list]))
  syncPushBookmark(bookmark)
  return bookmark
}

export async function removeHighlight(id: string) {
  return removeManyBookmarks([id])
}
