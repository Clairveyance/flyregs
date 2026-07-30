import AsyncStorage from '@react-native-async-storage/async-storage'
import type { FolderItemType } from '@/lib/folders'

const KEY = '@flyregs/recents'
const MAX = 50

export interface RecentAC {
  id: string
  /** Absent means 'ac' — every recent recorded before FAR/AIM/P-CG/AD
   * whole-document viewing existed (2026-07-25) has no itemType at all. */
  itemType?: FolderItemType
  document_number: string
  title: string
  date_issued: string | null
  subject_series: string | null
  viewedAt: string
}

export function recentItemType(r: Pick<RecentAC, 'itemType'>): FolderItemType {
  return r.itemType ?? 'ac'
}

export function routeForRecent(r: RecentAC): string {
  const type = recentItemType(r)
  if (type === 'far') return `/far/${r.id}`
  if (type === 'aim') return `/aim/${r.id}`
  if (type === 'pcg') return `/pcg/${r.id}`
  if (type === 'ad') return `/ad/${r.id}`
  if (type === 'loi') return `/loi/${r.id}`
  return `/ac/${r.id}`
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
