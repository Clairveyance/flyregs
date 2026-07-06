import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ACBlock } from '@/lib/acFormat'

const KEY = '@flyregs/downloads'

export interface DownloadedAC {
  id: string
  document_number: string
  title: string
  subject_series: string | null
  /** Approximate size in bytes of the cached content */
  size: number
  /**
   * Parsed blocks cached for offline rendering — this is what ac/[id].tsx
   * actually renders (via ACBody), so it's what must be stored for the
   * "downloaded" copy to be readable with no network connection.
   */
  pdf_blocks?: ACBlock[] | null
  downloadedAt: string
}

export async function getDownloads(): Promise<DownloadedAC[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function isDownloaded(id: string): Promise<boolean> {
  const list = await getDownloads()
  return list.some((d) => d.id === id)
}

export async function addDownload(ac: Omit<DownloadedAC, 'downloadedAt'>) {
  try {
    const list = await getDownloads()
    const filtered = list.filter((d) => d.id !== ac.id)
    const updated = [{ ...ac, downloadedAt: new Date().toISOString() }, ...filtered]
    await AsyncStorage.setItem(KEY, JSON.stringify(updated))
  } catch {}
}

export async function removeDownload(id: string) {
  try {
    const list = await getDownloads()
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((d) => d.id !== id)))
  } catch {}
}

export async function clearDownloads() {
  try {
    await AsyncStorage.removeItem(KEY)
  } catch {}
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
