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
    beforeSend: rescuePlainObjectErrors,
  })
}

// RESCUES THE MESSAGE OUT OF A NON-Error THROWN VALUE.
//
// Found 2026-09-05 while reading the actual issue list: REACT-NATIVE-5 is
// three production events across three weeks whose entire title is
//
//   "Object captured as exception with keys: code, details, hint, message"
//
// Those four keys are a PostgrestError. supabase-js does not throw -- it
// hands back a plain `{ code, details, hint, message }` object, which this
// codebase then either reports directly or re-throws. Sentry's
// captureException only knows how to title a real Error, so for anything
// else it falls back to listing the object's KEYS and drops the message.
// The result is an unresolved production issue with the diagnosis
// deliberately removed: we know a database call failed and we cannot know
// which one or why.
//
// Fixing this at the 38 individual captureException call sites would be
// churn, and would still miss the next one written. One hook covers every
// existing site and every future one.
//
// hint.originalException is the value as it was handed to captureException,
// before Sentry serialized it -- so the real message is still reachable here.
export function rescuePlainObjectErrors(
  event: Sentry.ErrorEvent,
  hint: Parameters<NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>["beforeSend"]>>[1],
): Sentry.ErrorEvent | null {
  const original: any = hint?.originalException
  if (!original || typeof original !== 'object' || original instanceof Error) return event

  const message = typeof original.message === 'string' ? original.message : null
  if (!message) return event

  const values = event.exception?.values
  if (values && values.length > 0) {
    // Only rewrite the placeholder Sentry generated for us. If something has
    // already produced a real type/value, leave it exactly as it is -- this
    // hook must never overwrite a genuine stack trace's own description.
    const top = values[values.length - 1]
    if (typeof top.value === 'string' && top.value.startsWith('Object captured as exception')) {
      // `code` is what makes two different database failures distinguishable
      // in the issue list; without it every PostgrestError groups together.
      top.type = typeof original.code === 'string' && original.code ? `DbError ${original.code}` : 'DbError'
      top.value = message
    }
  }

  event.extra = {
    ...event.extra,
    db_code: original.code ?? null,
    db_details: original.details ?? null,
    db_hint: original.hint ?? null,
  }
  return event
}
