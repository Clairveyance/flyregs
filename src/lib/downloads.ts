import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ACBlock } from '@/lib/acFormat'
import type { AcFigure, FormulaRef } from '@/types'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'
import { supabase } from '@/lib/supabase'
import { removeFromCache } from '@/lib/imageCache'
import { getLatestRevision, type RevisionDocType } from '@/lib/whatsChanged'

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
  /** AIM only: the paragraph's REFERENCE box. Rendered by aim/[id].tsx, and
   *  present on 115 of 438 paragraphs (measured), but the offline copy used
   *  to hardcode it to null -- so a downloaded paragraph silently lost it. */
  reference_text?: string | null
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

// far/aim/ad/cfr49's own docKey is the exact same identifier already stored
// as DownloadedAC.id for those 4 types (confirmed against every addDownload
// call site: e.g. far/[id].tsx's `id: section.section_number`, the same
// value that screen's own getLatestRevision('far', id) call already uses).
const REVISION_TYPES: DownloadedItemType[] = ['far', 'aim', 'ad', 'cfr49']

/**
 * True only when there is POSITIVE evidence a newer version of this
 * download's source content exists — never a guess. Real scenario this
 * closes: a pilot downloads an AD for offline preflight reading, the FAA
 * supersedes it weeks later, and every offline detail-screen render used
 * to be visually IDENTICAL to a live one — no signal whatsoever that the
 * text on screen might no longer reflect the current rule. See "Data Is
 * King" — for a document class where compliance is legally mandated,
 * silent staleness is a real accuracy gap, not a cosmetic one.
 *
 * Deliberately returns false (not an error, not a guess) for 'ac' when its
 * own updated_at lookup fails, and for 'pcg'/'loi', which have no revision-
 * tracking infrastructure at all yet (content_revisions has no 'loi'
 * doc_type, and 'pcg' has never logged a row in production) — "false" here
 * means "no evidence of staleness found," never "confirmed current." A
 * network failure (the common reason this is even being checked — the
 * offline fallback usually renders because there's NO connection) also
 * resolves false, silently: this is a best-effort upgrade to the always-
 * shown "Downloaded {date}" disclosure, never a blocking check.
 */
/**
 * Batched form of isDownloadStale for a whole list — TWO queries instead of N.
 *
 * The Saved tab ran `Promise.all(downloads.map(isDownloadStale))`, which is
 * one live request PER DOWNLOAD, re-fired on every focus (getDownloads()
 * returns a fresh array each call, so the effect's `[downloads]` dep always
 * changes identity). Fine at ten downloads; a stall and a battery/data drain
 * at two hundred — and `record_offline_download` has no cap, so a Premium
 * user can download the entire 786-AC library.
 *
 * Semantics are deliberately IDENTICAL to isDownloadStale, including its
 * "false means no evidence found, never confirmed-current" contract and its
 * silent degradation to "nothing flagged" with no network. This only changes
 * how many round trips it takes to reach the same answer. isDownloadStale
 * itself stays — the detail screens still check one document at a time.
 */
export async function getStaleDownloadIds(items: DownloadedAC[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (items.length === 0) return out
  const revItems = items.filter((d) => REVISION_TYPES.includes(downloadItemType(d)))
  const acItems = items.filter((d) => downloadItemType(d) === 'ac')
  try {
    if (revItems.length > 0) {
      const { data } = await supabase
        .from('content_revisions_gated')
        .select('doc_type, doc_key, revised_at')
        .in('doc_type', REVISION_TYPES)
        .in('doc_key', revItems.map((d) => d.id))
      // Keep only the newest revision per (type, key) — the per-item version
      // does this with `.order().limit(1)`, which cannot be expressed once
      // across a batch, so it is done here instead.
      const latest = new Map<string, string>()
      for (const r of (data ?? []) as { doc_type: string; doc_key: string; revised_at: string }[]) {
        const k = `${r.doc_type}:${r.doc_key}`
        const prev = latest.get(k)
        if (!prev || r.revised_at > prev) latest.set(k, r.revised_at)
      }
      for (const d of revItems) {
        const rev = latest.get(`${downloadItemType(d)}:${d.id}`)
        if (rev && new Date(rev).getTime() > new Date(d.downloadedAt).getTime()) out.add(d.id)
      }
    }
    if (acItems.length > 0) {
      const { data } = await supabase
        .from('advisory_circulars')
        .select('id, updated_at')
        .in('id', acItems.map((d) => d.id))
      const upd = new Map(
        ((data ?? []) as { id: string; updated_at: string }[]).map((r) => [r.id, r.updated_at]),
      )
      for (const d of acItems) {
        const u = upd.get(d.id)
        if (u && new Date(u).getTime() > new Date(d.downloadedAt).getTime()) out.add(d.id)
      }
    }
  } catch {
    // Same silent degradation as isDownloadStale: no network means nothing
    // flagged, never a false "current" claim and never a user-facing error.
  }
  return out
}

export async function isDownloadStale(item: DownloadedAC): Promise<boolean> {
  const type = downloadItemType(item)
  try {
    if (REVISION_TYPES.includes(type)) {
      const rev = await getLatestRevision(type as RevisionDocType, item.id)
      return !!rev && new Date(rev.revisedAt).getTime() > new Date(item.downloadedAt).getTime()
    }
    if (type === 'ac') {
      const { data } = await supabase.from('advisory_circulars').select('updated_at').eq('id', item.id).single()
      return !!data?.updated_at && new Date(data.updated_at).getTime() > new Date(item.downloadedAt).getTime()
    }
    return false
  } catch {
    return false
  }
}

// In-memory cache of the parsed list -- getDownloads() used to do a full
// AsyncStorage.getItem(KEY) + JSON.parse(raw) of the WHOLE offline library on
// every single call, and isDownloaded() (called via getDownloads()) runs in a
// useEffect on mount in all 7 regulation detail screens (ad/aim/ac/far/loi/
// pcg/cfr49). Combined with expo-router's router.push-based citation-chase
// navigation (which never unmounts a previous screen, just hides it -- see
// those screens' own navigation), a chain of citation taps meant re-parsing
// this same blob once per still-mounted screen instance.
//
// CORRECTED 2026-09-02: this cache is a fine optimisation, but the sentence
// that used to end this paragraph -- "suspected contributor to the
// WatchdogTermination (RAM) crashes seen in Sentry" -- was WRONG, and it was
// sending investigators down the wrong path. It was measured rather than
// re-assumed: a realistic 40-AC downloads blob built from real pdf_blocks is
// 2.2 MB, and parsing it takes ~3-4 ms (stringify ~5 ms) in V8, so call it
// 15-25 ms on Hermes. That is not a watchdog kill and never was.
//
// What DOES account for the watchdog kills, measured the same day: a single
// large AC mounts ~8,600 host views with no virtualisation (ACBody renders
// every block into a plain ScrollView -- AC 36-3H is 4,291 blocks), 14 CFR
// 171.311 rendered 4,709 table cells before TableGrid got its row cap, and
// push-only citation navigation keeps every one of those trees resident
// because nothing ever unmounts. The memory is in the VIEW TREES, not in this
// JSON. Fix the render paths, not this parse.
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
  // NOT wrapped in a swallowing try/catch any more. It used to be, which
  // meant an AsyncStorage write failure -- a device low on storage, exactly
  // the device most likely to be juggling offline downloads -- was invisible:
  // the server recorded the download, addDownload returned normally, and
  // every call site's `setDownloaded(true)` then told the user "Saved
  // offline" when NOTHING had been written. They find out on the plane.
  //
  // Every caller (ac/far/aim/pcg/ad/loi/cfr49 [id].tsx) already wraps this in
  // try/catch with a real "Error" dialog, so letting it throw is what those
  // handlers were written for. This store is also a single AsyncStorage key
  // holding every download (~81 KB of JSON per AC, 636 KB at the largest --
  // measured), re-serialised in full on every add, so a write failure here is
  // a genuinely reachable condition, not a theoretical one.
  const list = await getDownloads()
  const filtered = list.filter((d) => d.id !== ac.id)
  const updated = [{ ...ac, downloadedAt: new Date().toISOString() }, ...filtered]
  await AsyncStorage.setItem(KEY, JSON.stringify(updated))
  cache = null // invalidate -- see getDownloads' cache comment above
}


/** Image-cache keys this download owns.
 *
 * handleDownload() in ac/[id].tsx and ad/[id].tsx cache every figure and
 * formula-ref image under that row's OWN id, so the stored metadata is
 * already an exact manifest of what this download put on disk -- no schema
 * change and no network call needed to work out what to reclaim, which
 * matters because removal has to work offline. Legacy rows saved before
 * figures/formulaRefs were stored simply yield nothing and are left alone.
 */
function cachedImageKeys(item: DownloadedAC): string[] {
  return [
    ...(item.figures ?? []).map((f) => f.id),
    ...(item.formulaRefs ?? []).map((f) => f.id),
  ].filter(Boolean)
}

export async function removeDownload(id: string) {
  const item = await findDownload(id)
  // Same reasoning as addDownload: the LOCAL write is the thing the user is
  // being shown the result of, so a failure must reach the caller rather than
  // leave the row on disk while the UI shows it gone. (The SERVER call below
  // stays best-effort -- that one genuinely should not undo a local removal.)
  const list = await getDownloads()
  await AsyncStorage.setItem(KEY, JSON.stringify(list.filter((d) => d.id !== id)))
  cache = null
  // Reclaim the image bytes this download put on disk. Without this the row
  // vanished from the UI while every cached figure stayed forever -- AC
  // 43.13-1B alone is 378 figures averaging 326 KB (~123 MB, measured), and
  // no other code path ever freed them, so "remove" quietly reclaimed
  // nothing. Best-effort and AFTER the local write, so a delete failure can
  // never resurrect a row the user has already been shown as gone.
  if (item) {
    try { await removeFromCache(cachedImageKeys(item)) } catch {}
  }
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
  // Read the manifest BEFORE dropping it -- once KEY is gone there is no
  // record of which image files belonged to downloads, and they would be
  // orphaned on disk with nothing left able to identify them.
  let keys: string[] = []
  try { keys = (await getDownloads()).flatMap(cachedImageKeys) } catch {}
  try {
    await AsyncStorage.removeItem(KEY)
    cache = null
  } catch {}
  try { await removeFromCache(keys) } catch {}
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
