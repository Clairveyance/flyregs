import { useEffect, useState } from 'react'
import { Image, type ImageProps, type StyleProp, type ImageStyle } from 'react-native'

// RC, 2026-09-03: his aircraft photo "disappeared" on B39 -- still showed in
// the small Fleet-list thumbnail, but both the zoomed full-size view and the
// aircraft detail page's hero image showed nothing, then "after a while, it
// all came back" with no app update, no re-upload, nothing. Investigated:
// the storage bucket has been public since it was created and was never
// toggled; getAircraftImageUrl() is a pure function with no caching of its
// own; all three views call it with the identical stored image_path. No
// code path, RLS change, or expired-signed-URL mechanism explains it --
// which points at a transient network/CDN blip rather than a bug in the
// data or the logic (the thumbnail most likely kept showing an
// already-cached bitmap from an earlier successful load, while the two
// freshly-requested views hit the failure window with nothing cached yet).
//
// Can't prove the external cause from here, so this is the part that IS
// fully in the app's control either way: a plain RN <Image> has no retry at
// all -- one failed request and it renders nothing, forever, until
// something else causes a re-render with a different uri. This wraps that
// with ONE automatic retry after a short delay, which is exactly what would
// have turned a several-second blip into "never visibly broke" instead of
// "gone until RC happened to look again later." Used at all three aircraft-
// photo call sites (Fleet-list thumbnail, the zoomed viewer, and the detail
// page's hero image) so a future blip like this can't repeat as a bug
// report -- same fix, one shared place, instead of three copies to drift.
export function RetryImage({
  uri, style, retryDelayMs = 1000, ...rest
}: {
  uri: string
  style?: StyleProp<ImageStyle>
  retryDelayMs?: number
} & Omit<ImageProps, 'source' | 'style'>) {
  // Remounting the <Image> (via `key`) is what actually forces iOS to issue
  // a fresh network request -- just re-rendering with the same `uri` prop
  // does not, since RN's Image diffs props and skips an unchanged source.
  const [attempt, setAttempt] = useState(0)

  // A prop change (a different aircraft, a replaced photo -- image_path is
  // content-versioned, so a real replacement IS a different uri) must reset
  // the retry state, or a stale failed attempt count could suppress the
  // retry a genuinely NEW image deserves.
  useEffect(() => { setAttempt(0) }, [uri])

  return (
    <Image
      key={`${uri}-${attempt}`}
      source={{ uri }}
      style={style}
      onError={() => {
        // One retry only -- a second consecutive failure on the same
        // request is far more likely a truly missing/dead object than
        // another blip, and retrying forever on a real 404 would just spin
        // silently.
        if (attempt === 0) setTimeout(() => setAttempt(1), retryDelayMs)
      }}
      {...rest}
    />
  )
}
