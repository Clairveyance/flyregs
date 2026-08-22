import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ACBlock } from '@/lib/acFormat'
import type { AcFigure, FormulaRef } from '@/types'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'
import { supabase } from '@/lib/supabase'

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
export type DownloadedItemType = 'ac' | 'ad' | 'loi' | 'far' | 'aim' | 'pcg' | 'cfr49'

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
  if (type === 'cfr49') return `/cfr49/${item.id}`
  return `/ac/${item.id}`
}

/** The one cached copy for this id, or undefined. Used by every detail
 * screen's network-failure fallback so a downloaded document actually reads
 * offline — without this, `addDownload` is write-only storage. */
export async function findDownload(id: string): Promise<DownloadedAC | undefined> {
  const list = await getDownloads()
  return list.find((d) => d.id === id)
}

// In-memory cache of the parsed list -- getDownloads() used to do a full
// AsyncStorage.getItem(KEY) + JSON.parse(raw) of the WHOLE offline library on
// every single call, and isDownloaded() (called via getDownloads()) runs in a
// useEffect on mount in all 7 regulation detail screens (ad/aim/ac/far/loi/
// pcg/cfr49). Combined with expo-router's router.push-based citation-chase
// navigation (which never unmounts a previous screen, just hides it -- see
// those screens' own navigation), a chain of citation taps meant re-parsing
// this same blob once per still-mounted screen instance. Suspected
// contributor to the WatchdogTermination (RAM) crashes seen in Sentry.
// Populated on first read, reused after that; addDownload/removeDownload/
// clearDownloads invalidate it below rather than trying to patch it in place,
// so a mutation costs exactly one re-parse on the next read, not zero.
//
// Keyed by the signed-in user id (NO_USER_KEY while signed out) rather than
// cached unconditionally, because of how the account-mismatch guard below
// interacts with syncOwner.ts's claimDeviceIfMismatched: that function can
// WIPE this same AsyncStorage key (as part of resolving a genuine cross-
// account mismatch) in the same moment the guard's own verdict flips from
// "mismatched, return []" to "belongs to this user, proceed" -- both keyed
// off the exact same owner-tag write. A cache that didn't know about that
// transition would keep serving the PREVIOUS account's in-memory list right
// after the wipe, even though the guard now says it's fine to proceed. Every
// account transition (sign out, sign in, or a real mismatch handoff) changes
// currentUserId()'s return value, which is exactly what forces a cache miss
// here -- so a stale list can never survive across one. See folders.ts's
// getFolders() / syncOwner.ts's own comments for the leak this guard closes
// in the first place; this cache is not allowed to reopen it.
const NO_USER_KEY = '__signed_out__'
let cache: DownloadedAC[] | null = null
let cacheKey: string | null = null

// Same account-mismatch guard as folders.ts's getFolders() -- see that
// function's own comment for the leak this closes. Defense-in-depth: see
// recents.ts's getRecents() for why this stays even with the device-level
// claim in context/auth.tsx.
export async function getDownloads(): Promise<DownloadedAC[]> {
  try {
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
    const key = userId ?? NO_USER_KEY
    if (!cache || cacheKey !== key) {
      const raw = await AsyncStorage.getItem(KEY)
      cache = raw ? JSON.parse(raw) : []
      cacheKey = key
    }
    // Return a fresh top-level array each call (matching the old JSON.parse-
    // every-time behavior) so nothing can mutate the shared cache by mutating
    // what it got back -- cheap (reference copy), unlike the parse itself.
    // (`cache ?? []` rather than relying on the narrowing above: TS can't
    // prove `cache` is still non-null after the `await` inside that block,
    // since it's a module-level binding another call could in principle
    // touch in between.)
    return [...(cache ?? [])]
  } catch {
    return []
  }
}

export async function isDownloaded(id: string): Promise<boolean> {
  const list = await getDownloads()
  return list.some((d) => d.id === id)
}

// Gating audit, 2026-08-22, P2-6: this whole module used to be pure
// AsyncStorage with zero server involvement -- confirmed live, a patched
// Plus (or even Free) client could call addDownload directly and get the
// marketed Premium-exclusive feature for free, with no server able to
// tell the difference. Real architecture decision, not a quick patch: the
// underlying CONTENT isn't secret (a Plus subscriber already legitimately
// receives the exact same bytes reading this online), so there's no way
// to block SAVING what was already legitimately RECEIVED -- that's true
// of any reading app. What's real and enforceable is the tier boundary on
// the action of marking something offline in the first place, same shape
// as the aircraft/folder caps enforced elsewhere in this app.
// record_offline_download() is a security-definer RPC that checks Premium
// server-side and throws if it isn't met -- this call happens BEFORE the
// local AsyncStorage write, so a rejected download never gets cached at
// all. Every existing call site already has a try/catch around
// addDownload() for a generic "couldn't save" failure; the Premium
// rejection surfaces through that exact same path -- no call site changes
// needed, and a legitimate Premium user never sees it since their own
// screen's client-side check already keeps them from reaching this line
// in the overwhelming common case.
export async function addDownload(ac: Omit<DownloadedAC, 'downloadedAt'>) {
  const { error: gateError } = await supabase.rpc('record_offline_download', {
    p_item_type: downloadItemType(ac), p_item_id: ac.id,
  })
  if (gateError) throw gateError
  try {
    const list = await getDownloads()
    const filtered = list.filter((d) => d.id !== ac.id)
    const updated = [{ ...ac, downloadedAt: new Date().toISOString() }, ...filtered]
    await AsyncStorage.setItem(KEY, JSON.stringify(updated))
    cache = null // invalidate -- see getDownloads' cache comment above
  } catch {}
}

export async function removeDownload(id: string) {
  const item = await findDownload(id)
  try {
    const list = await getDownloads()
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((d) => d.id !== id)))
    cache = null
  } catch {}
  // Best-effort -- removing is never blocked, and a failure to clear the
  // server-side record shouldn't undo the local removal the user is
  // already looking at (hence the swallowed catch, after the local write
  // above has already committed). Guarded on `item` existing so this
  // doesn't fire for an id that was never actually downloaded.
  if (item) {
    try {
      await supabase.rpc('remove_offline_download', { p_item_type: downloadItemType(item), p_item_id: id })
    } catch {}
  }
}

export async function clearDownloads() {
  try {
    await AsyncStorage.removeItem(KEY)
    cache = null
  } catch {}
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
