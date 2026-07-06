import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = '@flyregs/recents'
const MAX = 50

export interface RecentAC {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  subject_series: string | null
  viewedAt: string
}

export async function addRecent(ac: Omit<RecentAC, 'viewedAt'>) {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const list: RecentAC[] = raw ? JSON.parse(raw) : []
    const filtered = list.filter((r) => r.id !== ac.id)
    const updated = [{ ...ac, viewedAt: new Date().toISOString() }, ...filtered].slice(0, MAX)
    await AsyncStorage.setItem(KEY, JSON.stringify(updated))
  } catch {}
}

export async function getRecents(): Promise<RecentAC[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function removeRecent(id: string) {
  try {
    const list = await getRecents()
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((r) => r.id !== id)))
  } catch {}
}

// Single read-modify-write for a batch of ids — looping removeRecent() via
// Promise.all is unsafe (each call reads the same stale snapshot, so only the
// last write survives). See lib/bookmarks.ts removeManyBookmarks for the same fix.
export async function removeManyRecents(ids: string[]) {
  try {
    const idSet = new Set(ids)
    const list = await getRecents()
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((r) => !idSet.has(r.id))))
  } catch {}
}

export async function clearRecents() {
  try {
    await AsyncStorage.removeItem(KEY)
  } catch {}
}
