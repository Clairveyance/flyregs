import { useEffect, useState } from 'react'
import { File, Paths } from 'expo-file-system'
import AsyncStorage from '@react-native-async-storage/async-storage'

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

// Returns the best available local URI for `remoteUrl` right away — a
// previously cached copy if one exists (even with no network at all) —
// while downloading a fresh copy in the background whenever `remoteUrl`
// doesn't match what's cached (avatar upload URLs are cache-busted with a
// `?t=` timestamp, so any URL change means a genuinely new photo, not just a
// re-check of the same one). `idempotent: true` lets the download overwrite
// the existing file atomically instead of throwing/needing a manual delete
// first, so whatever's already on screen never flashes blank mid-refresh.
export async function getCachedImageUri(
  key: string,
  remoteUrl: string,
  onUpdate?: (uri: string) => void
): Promise<string | null> {
  const local = localFileFor(key, remoteUrl)
  const map = await getCacheMap()
  const isFresh = map[key] === remoteUrl && local.exists

  if (!isFresh) {
    ;(async () => {
      try {
        const downloaded = await File.downloadFileAsync(remoteUrl, local, { idempotent: true })
        const prevUrl = await setCacheEntry(key, remoteUrl)
        onUpdate?.(downloaded.uri)
        if (prevUrl && prevUrl !== remoteUrl) {
          try { localFileFor(key, prevUrl).delete() } catch {}
        }
      } catch {
        // Offline or the fetch failed — whatever's already cached (if
        // anything) keeps showing; nothing worse happens.
      }
    })()
  }

  return local.exists ? local.uri : null
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
