import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ACBlock } from '@/lib/acFormat'
import type { AcFigure, FormulaRef } from '@/types'

const KEY = '@flyregs/downloads'

// 'ac' keeps its full pdf_blocks/figures/formulaRefs shape (see below) --
// every other type is a simpler document (plain body text, no block-parsed
// structure) so its offline copy is just the already-loaded text fields,
// with no separate image-caching pipeline.
//
// FAR/AIM/PCG were added last and are the reason this is worth spelling
// out: they have NO PDF anywhere in the schema (eCFR XML / FAA HTML
// sources), so they get no "Open PDF" button -- but offline reading has
// nothing to do with PDFs, and withholding it from the three biggest
// regulation sets made "offline access" a Premium feature that didn't
// cover the FARs. Availability of a PDF and availability of offline are
// now two independent questions; see DetailActionRow.
export type DownloadedItemType = 'ac' | 'ad' | 'loi' | 'far' | 'aim' | 'pcg'

export interface DownloadedAC {
  id: string
  type?: DownloadedItemType // absent/undefined on legacy rows == 'ac', for back-compat with data saved before this field existed
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
  /**
   * Figures & Tables / Formulas-to-Verify metadata, cached alongside the
   * text — without this, the offline copy's Figures & Tables section had
   * nothing to render at all (the live query that would normally populate
   * it just fails with no network). The actual image BYTES are cached
   * separately via imageCache.ts, keyed by each entry's own `id` — see
   * handleDownload() in ac/[id].tsx, which pre-downloads every one of these
   * images before the AC is considered "saved offline."
   */
  figures?: AcFigure[] | null
  formulaRefs?: FormulaRef[] | null
  /** Non-AC offline copy (FAR/AIM/PCG/AD/LOI): the plain body text already
   * loaded by the detail screen, stored as-is (no block parsing) since
   * these render via PlainTextBody, not ACBody. */
  body_text?: string | null
  downloadedAt: string
}

/** A download's own type, defaulting missing/legacy rows to 'ac' — rows
 * written before the `type` field existed are all ACs. */
export function downloadItemType(d: Pick<DownloadedAC, 'type'>): DownloadedItemType {
  return d.type ?? 'ac'
}

// Single source of truth for "where does tapping this download go", mirroring
// bookmarks.ts's routeForBookmark. Saved's Offline tab previously hardcoded
// `/ac/${item.id}` for every row, so a downloaded AD or LOI opened
// /ac/<ad_number> -- a real advisory_circulars lookup miss landing the user
// on "not found", i.e. the offline copy they'd just saved was unreachable.
export function routeForDownload(item: DownloadedAC): string {
  const type = downloadItemType(item)
  if (type === 'far') return `/far/${item.id}`
  if (type === 'aim') return `/aim/${item.id}`
  if (type === 'pcg') return `/pcg/${item.id}`
  if (type === 'ad') return `/ad/${item.id}`
  if (type === 'loi') return `/loi/${item.id}`
  return `/ac/${item.id}`
}

/** The one cached copy for this id, or undefined. Used by every detail
 * screen's network-failure fallback so a downloaded document actually reads
 * offline — without this, `addDownload` is write-only storage. */
export async function findDownload(id: string): Promise<DownloadedAC | undefined> {
  const list = await getDownloads()
  return list.find((d) => d.id === id)
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
