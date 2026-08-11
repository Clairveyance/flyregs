import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { File, Paths } from 'expo-file-system'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { resolveGatedStorageUrl } from '@/lib/gatedStorage'

// Generic "download once, reuse forever until the source changes" cache for
// remote images (avatars, shared-folder owner photos) — without this, every
// screen that shows a photo re-fetches it over the network on every render,
// which is why the avatar appeared to "load" each time and went blank on
// poor wifi. Files persist in the document directory (not cache, which the
// OS can purge) since a profile photo should behave like it's attached to
// the account, not like disposable scratch data.
const MAP_KEY = '@flyregs/imageCacheMap'

async function getCacheMap(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(MAP_KEY)
  return raw ? JSON.parse(raw) : {}
}

// Returns the PREVIOUS url that was cached under `key`, if any, so the
// caller can clean up the now-orphaned file for that version.
async function setCacheEntry(key: string, url: string): Promise<string | undefined> {
  const map = await getCacheMap()
  const prevUrl = map[key]
  map[key] = url
  await AsyncStorage.setItem(MAP_KEY, JSON.stringify(map))
  return prevUrl
}

// The physical filename is versioned by the remote URL itself (avatar/owner
// photo URLs carry a `?t=` cache-busting timestamp, so this is unique per
// upload), not just by `key` -- this used to be `imagecache_${key}.jpg` for
// every version, which meant a new photo download overwrote the SAME file a
// currently-visible <Image> was already pointing at. Overwriting bytes
// in-place under an unchanged URI let the native image cache go on showing
// the OLD bitmap for that URI, which is what caused the "shows an older
// photo, sometimes the newer one, jumbled across screens" bug: whichever
// screen's Image had already decoded that path kept whatever it had, purely
// based on load timing, regardless of which photo was actually current. A
// per-version filename means a new photo is a genuinely new URI, so there's
// nothing to overwrite and nothing stale to serve.
function versionFor(remoteUrl: string): string {
  const query = remoteUrl.split('?')[1]
  return (query ?? remoteUrl).replace(/[^a-zA-Z0-9]/g, '_')
}

function localFileFor(key: string, remoteUrl: string): File {
  return new File(Paths.document, `imagecache_${key}_${versionFor(remoteUrl)}.jpg`)
}

// Shared by both getCachedImageUri's fire-and-forget background refresh and
// downloadImageToCache's genuinely-awaited download below -- one real
// download-and-bookkeeping implementation, not two copies that could drift.
//
// resolveFetchUrl is optional and LAZY (a thunk, not a pre-resolved string)
// -- called only when a download is actually about to happen, never on a
// cache hit. This matters for gated content (see useGatedCachedImage
// below): resolving it eagerly would mint a fresh signed URL on every
// single mount even when the image is already on disk and about to render
// instantly from cache, for no reason. remoteUrl stays the STABLE
// identifier for cache-key/freshness/versioning either way -- a signed URL
// embeds a fresh token on every mint, so using it as the cache key would
// make every re-resolution of the SAME object look like a new image and
// force a redundant re-download every time.
async function downloadAndCache(
  key: string,
  remoteUrl: string,
  local: File,
  resolveFetchUrl?: () => Promise<string | null>
): Promise<string | null> {
  try {
    const fetchUrl = resolveFetchUrl ? await resolveFetchUrl() : remoteUrl
    if (!fetchUrl) return null
    const downloaded = await File.downloadFileAsync(fetchUrl, local, { idempotent: true })
    const prevUrl = await setCacheEntry(key, remoteUrl)
    if (prevUrl && prevUrl !== remoteUrl) {
      try { localFileFor(key, prevUrl).delete() } catch {}
    }
    return downloaded.uri
  } catch {
    // Offline or the fetch failed — whatever's already cached (if anything)
    // keeps showing; nothing worse happens.
    return null
  }
}

// Returns the best available local URI for `remoteUrl` right away — a
// previously cached copy if one exists (even with no network at all) —
// while downloading a fresh copy in the background whenever `remoteUrl`
// doesn't match what's cached (avatar upload URLs are cache-busted with a
// `?t=` timestamp, so any URL change means a genuinely new photo, not just a
// re-check of the same one). `idempotent: true` lets the download overwrite
// the existing file atomically instead of throwing/needing a manual delete
// first, so whatever's already on screen never flashes blank mid-refresh.
//
// Deliberately does NOT wait for that background download before
// resolving -- the whole point for its callers (avatars, shared-folder
// owner photos rendered inline in a list) is an instant response with a
// later swap-in, never a blocking spinner. A caller that actually needs to
// KNOW the bytes are on disk before proceeding (offline downloads, see
// downloadImageToCache below) must not use this function -- confirmed live,
// post-build-31 sweep: handleDownload() in ac/[id].tsx used to Promise.
// allSettled over this function expecting it to wait, but it resolves in
// single-digit milliseconds regardless of image size or network speed,
// letting "Saved offline" fire while every figure image was still mid-
// download in the background -- a real race if the network dropped before
// that background download finished, with no error or placeholder shown.
export async function getCachedImageUri(
  key: string,
  remoteUrl: string,
  onUpdate?: (uri: string) => void,
  resolveFetchUrl?: () => Promise<string | null>
): Promise<string | null> {
  // expo-file-system's File/Paths API has no web implementation at all —
  // confirmed live, reproducibly: opening any FigureViewer in web preview
  // threw "this.validatePath is not a function" from inside
  // new File(Paths.document, ...), surfacing as an Expo redbox that kicked
  // the user straight out of the preview mid-navigation. Web has no
  // meaningful persistent file cache to offer here anyway — skip straight
  // to "just use the remote URL", the same graceful fallback this hook
  // already promises for any other cache-miss case (see its own docstring:
  // "nothing regresses if the cache lookup fails").
  if (Platform.OS === 'web') return null
  const local = localFileFor(key, remoteUrl)
  const map = await getCacheMap()
  const isFresh = map[key] === remoteUrl && local.exists

  if (!isFresh) {
    downloadAndCache(key, remoteUrl, local, resolveFetchUrl).then((uri) => { if (uri) onUpdate?.(uri) })
  }

  return local.exists ? local.uri : null
}

// The awaitable counterpart to getCachedImageUri, for the one caller that
// actually needs to know the real bytes are on disk before it's honest to
// say "this is available offline" -- see that function's own comment for
// the exact bug this exists to close. Resolves only once the download
// genuinely finishes (or fails); never returns before the file is real.
export async function downloadImageToCache(
  key: string,
  remoteUrl: string,
  resolveFetchUrl?: () => Promise<string | null>
): Promise<string | null> {
  if (Platform.OS === 'web') return null
  const local = localFileFor(key, remoteUrl)
  const map = await getCacheMap()
  if (map[key] === remoteUrl && local.exists) return local.uri
  return downloadAndCache(key, remoteUrl, local, resolveFetchUrl)
}

// React binding for getCachedImageUri — starts by showing `remoteUrl`
// directly (identical to the old un-cached behavior, so nothing regresses if
// the cache lookup fails for any reason), then swaps to the local cached
// file as soon as it's available. `key` should be stable per subject (e.g.
// the user id for "my own" avatar, a folder id for a shared-folder owner's
// photo) — NOT the URL itself, since the URL changes every time the photo
// does.
export function useCachedImage(key: string | null, remoteUrl: string | null): string | null {
  const [uri, setUri] = useState<string | null>(remoteUrl)

  useEffect(() => {
    let cancelled = false
    setUri(remoteUrl)
    if (!key || !remoteUrl) return
    getCachedImageUri(key, remoteUrl, (fresh) => {
      if (!cancelled) setUri(fresh)
    }).then((cached) => {
      if (!cancelled && cached) setUri(cached)
    })
    return () => {
      cancelled = true
    }
  }, [key, remoteUrl])

  return uri
}

// Gated counterpart to useCachedImage, for figures/formula-refs/PDFs stored
// in a private bucket (see gatedStorage.ts) -- `publicUrl` is the stable,
// scraper-written "public-style" URL string (still used as the cache key
// and version identifier, unchanged), not something directly fetchable
// anymore. Unlike useCachedImage, this deliberately does NOT initialize
// with publicUrl itself: that string 401s against a private bucket, so
// showing it immediately would just be a guaranteed-broken image for the
// one render before the cache/signing resolves, instead of the loading
// state the caller should show for that brief window.
export function useGatedCachedImage(key: string | null, publicUrl: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUri(null)
    if (!key || !publicUrl) return
    // getCachedImageUri short-circuits to null on web with no other effect
    // (expo-file-system has no web implementation -- see its own comment) --
    // useCachedImage papers over that by never overwriting its initial
    // raw-url state, but this hook starts at null on purpose (see above),
    // so without this branch web would show a permanent spinner instead of
    // ever resolving anything. Sign and use directly, same "no cache to
    // offer, just fetch live" fallback useCachedImage already has for web.
    if (Platform.OS === 'web') {
      resolveGatedStorageUrl(publicUrl).then((signed) => { if (!cancelled) setUri(signed) })
      return () => { cancelled = true }
    }
    getCachedImageUri(key, publicUrl, (fresh) => {
      if (!cancelled) setUri(fresh)
    }, () => resolveGatedStorageUrl(publicUrl)).then((cached) => {
      if (!cancelled && cached) setUri(cached)
    })
    return () => {
      cancelled = true
    }
  }, [key, publicUrl])

  return uri
}

// Gated counterpart to downloadImageToCache, for the offline-download path
// (handleDownload in ac/[id].tsx) -- resolves a signed URL only if a real
// network fetch turns out to be needed (see downloadAndCache's own comment
// on why the resolver is lazy).
export async function downloadGatedImageToCache(key: string, publicUrl: string): Promise<string | null> {
  return downloadImageToCache(key, publicUrl, () => resolveGatedStorageUrl(publicUrl))
}
