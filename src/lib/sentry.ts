import { Platform } from 'react-native'
import * as Sentry from '@sentry/react-native'

// Navigation instrumentation. Exported so _layout.tsx can hand it the
// expo-router container ref -- without that registration it produces nothing.
//
// WHY THIS EXISTS
// `tracesSampleRate: 0.2` has been set since tracing was turned on, but
// nothing ever created a transaction to sample, so **the project has never
// collected a single page-open timing.** RC has reported repeatedly that the
// app is slow to open screens, most recently "B40 is MASSIVELY slower than
// all previous builds. all pages take a ridiculously long time to open", and
// there has been no way to answer him with a measurement -- only by reading
// code and guessing. Worse, Sentry's last event from B40 is 33 seconds after
// the release was created: two days of real use, including a lockup he
// emailed about, produced nothing at all.
//
// A spinner is not an ANR, so app-hang tracking correctly stayed quiet for
// that lockup. Screen-load timing is the thing that would actually have
// caught it, and it is the thing that was missing.
export const routingInstrumentation = Sentry.reactNavigationIntegration({
  // Time from navigation dispatch to the first frame of the new screen --
  // "how long did this page take to open", which is the exact question being
  // asked. Off by default.
  enableTimeToInitialDisplay: true,

  // THE DEFAULT HERE IS 1,000 ms, AND IT DISCARDS THE TRANSACTION.
  //
  // Checked in the installed package rather than assumed
  // (node_modules/@sentry/react-native/.../reactnavigation.js: "How long the
  // instrumentation will wait for the route to mount after a change has been
  // initiated, before the transaction is discarded"). With the default, any
  // screen taking longer than one second to mount is THROWN AWAY -- which is
  // precisely the population RC is complaining about. Shipping the default
  // would have added instrumentation that is blind to the only thing it was
  // added to measure.
  //
  // 30s keeps the genuinely slow opens, including one that never finishes
  // rendering at all.
  routeChangeTimeoutMs: 30_000,

  // Keep back-navigations that produced no spans out of the data; they are
  // noise and this is the library's own default.
  ignoreEmptyBackNavigationTransactions: true,
})

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
    // 1.0 FOR THE BETA, deliberately, not a default left unchanged.
    //
    // At 0.2, four out of five screen opens are discarded before they are
    // ever sent. With a beta of ~5 real users that is close to no data at
    // all, and the whole reason this instrumentation is being added is that
    // there is no data. Verified against Sentry's own stats API before
    // raising it: **0 transactions and 0 spans in the last 30 days**, against
    // 95 errors -- so there is no existing volume to multiply, and the plan's
    // on-demand spend is 0, meaning an over-quota month drops events rather
    // than billing anything.
    //
    // LOWER THIS BEFORE PUBLIC LAUNCH -- at real user counts 1.0 is both
    // wasteful and unnecessary; 0.1-0.2 is plenty once there is volume.
    tracesSampleRate: 1.0,
    enableAutoSessionTracking: true,
    integrations: [routingInstrumentation],

    // FAILED NETWORK REQUESTS. Off by default, and the single biggest gap in
    // what this project was reporting.
    //
    // Every silent-failure bug found in this codebase has the same shape: a
    // request fails, supabase-js RESOLVES {data, error} instead of throwing,
    // and the app renders as if nothing happened. Nothing reaches Sentry
    // because nothing throws. With this on, the failed HTTP call itself is
    // reported even when the app swallows the result -- which is exactly the
    // class RC keeps having to find by hand and report.
    enableCaptureFailedRequests: true,

    // SCREENSHOT ON ERROR. RC turned this on deliberately (2026-09-07) after
    // being told exactly what it costs.
    //
    // WHAT IT DOES: when an error is captured, the SDK attaches a PNG of the
    // app screen at that moment. It fires on ERRORS ONLY -- not on every
    // screen, not on navigation, not on a timer.
    //
    // WHAT IT COSTS: that image can contain whatever the user was looking at
    // -- their aircraft, their notes, their email address in Account. It is
    // uploaded to Sentry and visible to anyone with access to the project.
    // Acceptable for a ~5-person beta that is mostly RC's own device; it is
    // NOT obviously acceptable at public-launch scale.
    //
    // >>> REVISIT BEFORE PUBLIC LAUNCH, alongside tracesSampleRate above. <<<
    //
    // Why it is worth it now: every visual bug this beta has produced --
    // repeated T&Fs on AIM 2-1-8, "Save an aircraft" shown to someone who has
    // one, the Changed-tab spinner -- was reported by RC in prose or a
    // screenshot he took by hand. The B40 aircraft-photo failure produced a
    // Sentry event with a perfectly good stack trace and no way to see that
    // the user was staring at "Could not update this aircraft's photo."
    attachScreenshot: true,

    // Defaults verified in the installed package rather than assumed, and
    // deliberately LEFT at their defaults:
    //   enableAppHangTracking     true, appHangTimeoutInterval 2s -- already
    //                             the right setting for "the app locked up"
    //   enableStallTracking       true -- JS event-loop stalls are attached
    //                             as measurements to every transaction, which
    //                             is precisely the signal for a frozen screen
    //   enableWatchdogTerminationTracking  true -- iOS OOM kills
    //
    // Deliberately NOT enabled, so the choice is on the record:
    //   attachViewHierarchy -- redundant now that screenshots are on, and it
    //     carries the same privacy cost for far less diagnostic value.
    //   enableUserInteractionTracing -- creates a transaction per touch. At
    //     tracesSampleRate 1.0 that would bury the navigation timings this was
    //     added to collect.
    //   profilesSampleRate -- the plan's profileDuration quota is 0, so it
    //     would be sent and dropped.
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
