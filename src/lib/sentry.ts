import { Platform } from 'react-native'
import * as Sentry from '@sentry/react-native'

export function initSentry() {
  // The web preview build isn't a real distribution target for this app --
  // @sentry/react-native expects native modules that don't exist there.
  if (Platform.OS === 'web') return

  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN

  if (!dsn) {
    console.warn('[Sentry] DSN not configured — crash/error reporting disabled')
    return
  }

  Sentry.init({
    dsn,
    tracesSampleRate: 0.2,
    enableAutoSessionTracking: true,
  })
}
