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

async function setCacheEntry(key: string, url: string) {
  const map = await getCacheMap()
  map[key] = url
  await AsyncStorage.setItem(MAP_KEY, JSON.stringify(map))
}

function localFileFor(key: string): File {
  return new File(Paths.document, `imagecache_${key}.jpg`)
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
  const local = localFileFor(key)
  const map = await getCacheMap()
  const isFresh = map[key] === remoteUrl && local.exists

  if (!isFresh) {
    ;(async () => {
      try {
        const downloaded = await File.downloadFileAsync(remoteUrl, local, { idempotent: true })
        await setCacheEntry(key, remoteUrl)
        onUpdate?.(downloaded.uri)
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
