import { useEffect } from 'react'
import { Platform } from 'react-native'
import * as ScreenOrientation from 'expo-screen-orientation'

// Allows the device to rotate freely while `active` is true -- meant only for
// full-page document views (the PDF viewer, the Figures & Tables image
// viewer) where seeing more of a page landscape is genuinely useful, not for
// the app's normal screens (app.json still locks those to portrait). Snaps
// back to portrait the instant `active` goes false or the caller unmounts,
// even if the device is currently sitting in landscape -- so leaving a doc
// view always returns the rest of the app to portrait, never leaves it
// stuck sideways. No-op on web, where ScreenOrientation has no real effect.
export function useAllowRotation(active: boolean) {
  useEffect(() => {
    if (Platform.OS === 'web' || !active) return
    ScreenOrientation.unlockAsync()
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
    }
  }, [active])
}
