import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = '@flyregs/bookmarks'

export interface BookmarkAC {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  savedAt: string
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
  const updated = [{ ...ac, savedAt: new Date().toISOString() }, ...list]
  await AsyncStorage.setItem(KEY, JSON.stringify(updated))
  // Cloud sync is Premium-gated — see saved.tsx toggleSync
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
  // Cloud sync is Premium-gated — see saved.tsx toggleSync
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
