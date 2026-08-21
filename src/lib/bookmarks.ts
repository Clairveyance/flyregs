import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncPushBookmark, syncPushBookmarkDeletes } from '@/lib/syncPush'
import { removeItemsFromAllFolders, FolderItemType } from '@/lib/folders'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'
import { withLock } from '@/lib/asyncMutex'

const KEY = '@flyregs/bookmarks'

export interface BookmarkAC {
  id: string
  /** Absent means 'ac' — every bookmark saved before FAR/AIM/P-CG/AD
   * whole-document bookmarking existed (2026-07-25) has no itemType field at
   * all, so treat a missing value as 'ac' everywhere instead of migrating
   * old rows. Highlights (blockText set) now exist for every PlainTextBody/
   * paragraph-rendered type (far/aim/pcg/ad/loi), not just 'ac' — see the
   * Highlights section below. */
  itemType?: FolderItemType
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  savedAt: string
  /** Present only for a "highlight" — a bookmark scoped to one block/
   * paragraph within the document rather than the whole thing. `id` here is
   * a freshly generated value, NOT the document's own id (unlike a
   * whole-doc bookmark, where id === acId) — that's what lets a whole-doc
   * bookmark and any number of highlights coexist for the same document
   * without id collisions. `acId` is what actually points back to the
   * bookmarked document — despite the name, this is generic across every
   * itemType (AC, FAR, AIM, P/CG, AD, LOI), not AC-specific; it's paired
   * with `itemType` (see getHighlightsForAC/findHighlight/addHighlight
   * below) so a FAR highlight and an AC highlight can never collide even if
   * their underlying ids happened to be the same string. */
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
// real advisory_circulars.id).
export function routeForBookmark(item: BookmarkAC, opts?: { hlId?: string }): string {
  const type = bookmarkItemType(item)
  if (type === 'ac') {
    const acId = resolveBookmarkACId(item)
    // hlId looks up a highlight in the CALLER's own local bookmark list (see
    // ac/[id].tsx) -- correct for the owner opening their own highlight, but
    // a no-op for anyone else (a shared-folder collaborator, a Study Mode
    // jump-target recipient) who never had that row locally. blockText
    // doesn't have that limitation -- ac/[id].tsx's own ?hlText= handler
    // locates the passage by matching content directly against this
    // device's copy of the doc, and creates a real highlight for THIS
    // viewer at that spot (see its own comment), so it's included whenever
    // available rather than only as a fallback -- harmless to include
    // alongside hlId since the two jump to the same place.
    const params = new URLSearchParams()
    if (opts?.hlId) params.set('hlId', opts.hlId)
    if (item.blockText) params.set('hlText', item.blockText.slice(0, 120))
    const qs = params.toString()
    return qs ? `/ac/${acId}?${qs}` : `/ac/${acId}`
  }
  // A non-AC bookmark carrying blockText is either a highlight (see the
  // Highlights section below) or a Study Mode flashcard's saved jump-target
  // -- either way it knows which passage it came from, so pass it through as
  // `hl` and the detail screen highlights/scrolls to that spot (see each
  // screen's own `hl` param handling) instead of opening at the top.
  const hl = item.blockText ? `?hl=${encodeURIComponent(item.blockText)}` : ''
  // resolveBookmarkACId, NOT item.id directly -- a highlight's own `id` is a
  // freshly generated synthetic value (see BookmarkAC's comment), so for a
  // FAR/AIM/P-CG/AD/LOI highlight `item.id` is NOT a real section/paragraph/
  // AD/LOI id at all and would 404. This branch used to read item.id
  // unconditionally, which happened to be harmless only because highlights
  // were AC-only until now (a whole-doc bookmark's id === its acId, so the
  // two were indistinguishable there) -- now that every type can have
  // highlights, the real underlying doc id has to be resolved explicitly.
  const docId = resolveBookmarkACId(item)
  if (type === 'far') return `/far/${docId}${hl}`
  if (type === 'aim') return `/aim/${docId}${hl}`
  if (type === 'pcg') return `/pcg/${docId}${hl}`
  if (type === 'ad') return `/ad/${docId}${hl}`
  if (type === 'cfr49') return `/cfr49/${docId}${hl}`
  // LOI bookmarks store the LOI's own slug as `id` (see loi/[slug].tsx's
  // toggleBookmark call), matching /loi/[slug]'s route param directly --
  // was missing entirely, so a synced LOI bookmark silently mis-routed to
  // /ac/<slug> (a real AC lookup miss) before this fix. Carries `hl` like
  // every other non-AC type above; it alone used to return bare, so a LOI
  // bookmark could never open at its passage even once loi/[slug].tsx knew
  // how to honor the param.
  if (type === 'loi') return `/loi/${docId}${hl}`
  // Dictionary bookmarks store the term's own slug as `id`, matching
  // /dictionary/[slug]'s route param -- same pattern as loi above.
  if (type === 'dictionary') return `/dictionary/${item.id}`
  return `/ac/${item.id}` // 'note' never reaches here — notes aren't bookmarks
}

// Same account-mismatch guard as folders.ts's getFolders() -- see that
// function's own comment for the leak this closes. This store is likewise
// global/unnamespaced (see syncOwner.ts).
export async function getBookmarks(): Promise<BookmarkAC[]> {
  try {
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
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
  // withLock('bookmarks', ...) here and on every other read-modify-write in
  // this file -- serializes against both each other AND sync.ts's
  // mergeBookmarks (same lock key), which used to be able to silently
  // clobber a local write like this one if it landed mid-merge. See
  // asyncMutex.ts's own header comment for the full story.
  return withLock('bookmarks', async () => {
    const list = await getBookmarks()
    if (list.some((b) => b.id === ac.id)) return
    const bookmark = { ...ac, savedAt: new Date().toISOString() }
    await AsyncStorage.setItem(KEY, JSON.stringify([bookmark, ...list]))
    syncPushBookmark(bookmark)
  })
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
  return withLock('bookmarks', async () => {
    const list = await getBookmarks()
    const existing = new Set(list.map((b) => b.id))
    const now = new Date().toISOString()
    const toAdd = acs.filter((ac) => !existing.has(ac.id)).map((ac) => ({ ...ac, savedAt: now }))
    if (toAdd.length === 0) return
    await AsyncStorage.setItem(KEY, JSON.stringify([...toAdd, ...list]))
    toAdd.forEach((b) => syncPushBookmark(b))
  })
}

export async function removeBookmark(id: string) {
  return removeManyBookmarks([id])
}

// Removes several bookmarks in one read-modify-write. Calling removeBookmark in
// a Promise.all loop is unsafe — each call reads the same pre-write snapshot of
// AsyncStorage, so concurrent writes clobber each other and only the last
// removal survives. This does the read once, removes everything, writes once.
export async function removeManyBookmarks(ids: string[]) {
  const removed = await withLock('bookmarks', async () => {
    const list = await getBookmarks()
    const idSet = new Set(ids)
    const rem = list.filter((b) => idSet.has(b.id))
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((b) => !idSet.has(b.id))))
    syncPushBookmarkDeletes(ids)
    return rem
  })
  // A removed bookmark may still be referenced by one or more folders — drop
  // those references too, or the folder's item count silently drifts ahead
  // of what it actually renders (see folders.ts's removeItemsFromAllFolders).
  // Removed ids can span multiple content types in one call (e.g. a
  // multi-select bulk delete in Saved), so group by each bookmark's own
  // itemType rather than assuming everything being removed is an 'ac'.
  // Outside the 'bookmarks' lock above (this touches the separate 'folders'
  // domain, via removeItemsFromAllFolders's own lock) -- deliberately not
  // nested inside it, since a lock this file doesn't own has no business
  // being acquired from inside another lock's critical section.
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
// (non-doc) id, so it shows up in the same Saved list, the same sync
// pipeline, and inherits the same tier gating with no separate code path.
// Originally AC-only; itemType defaults to 'ac' below so every existing AC
// call site keeps working unchanged, but every FAR/AIM/P-CG/AD/LOI detail
// screen now passes its own itemType too, scoping the acId+blockText lookup
// so a highlight can never collide with another content type's doc sharing
// the same underlying id string.

export async function getHighlightsForAC(acId: string, itemType: FolderItemType = 'ac'): Promise<BookmarkAC[]> {
  const list = await getBookmarks()
  return list.filter((b) => b.acId === acId && b.blockText && bookmarkItemType(b) === itemType)
}

export async function findHighlight(acId: string, blockText: string, itemType: FolderItemType = 'ac'): Promise<BookmarkAC | undefined> {
  const list = await getBookmarks()
  return list.find((b) => b.acId === acId && b.blockText === blockText && bookmarkItemType(b) === itemType)
}

export async function addHighlight(h: {
  acId: string
  itemType?: FolderItemType
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
  return withLock('bookmarks', async () => {
    const list = await getBookmarks()
    const bookmark: BookmarkAC = { ...h, itemType: h.itemType ?? 'ac', id, savedAt: new Date().toISOString() }
    await AsyncStorage.setItem(KEY, JSON.stringify([bookmark, ...list]))
    syncPushBookmark(bookmark)
    return bookmark
  })
}

export async function removeHighlight(id: string) {
  return removeManyBookmarks([id])
}
