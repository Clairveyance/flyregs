import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncPushBookmark, syncPushBookmarkDeletes } from '@/lib/syncPush'
import { removeItemsFromAllFolders } from '@/lib/folders'

const KEY = '@flyregs/bookmarks'

export interface BookmarkAC {
  id: string
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
  await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((b) => !idSet.has(b.id))))
  syncPushBookmarkDeletes(ids)
  // A removed bookmark may still be referenced by one or more folders — drop
  // those references too, or the folder's item count silently drifts ahead
  // of what it actually renders (see folders.ts's removeItemsFromAllFolders).
  await removeItemsFromAllFolders('ac', ids)
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
