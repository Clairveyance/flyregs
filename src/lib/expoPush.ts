import * as Sentry from '@sentry/react-native'

// One place that actually READS what Expo says about a push.
//
// RC, 2026-09-05: "There is zero notification happening when somebody invites
// you to a folder" and "the notifications for a duel challenge on the
// recipient phone are still not working."
//
// THE BLIND SPOT
// Every push sender in this app posted to exp.host and then checked, at most,
// `res.ok`. That is the wrong thing to check. The Expo push API answers a
// send with HTTP 200 and puts the real outcome in the BODY, one ticket per
// message:
//
//   {"data":[{"status":"error","message":"\"ExponentPushToken[...]\" is not a
//     registered push credential","details":{"error":"DeviceNotRegistered"}}]}
//
// That is an HTTP 200. `res.ok` is true. So a push that Apple never even saw
// -- a token that went stale after a reinstall, a device that revoked
// permission, a credential mismatch after a rebuild -- looked exactly like a
// delivered one, from the sending side, forever. Nothing was logged, nothing
// reached Sentry, and the only symptom available to anybody was RC's: the
// notification does not arrive and there is no reason anywhere.
//
// This is the same silent-failure class as supabase-js resolving {data,error}
// instead of throwing, which this codebase has been bitten by repeatedly. The
// fix is the same: read the result, and say so when it is bad.
//
// WHAT THIS DOES NOT FIX
// It does not, by itself, make a single push arrive. It makes a failed push
// LEGIBLE -- in Sentry, tagged with which feature and which recipient -- so
// "zero notifications" stops being a mystery and becomes a specific error
// code. That distinction is worth stating plainly rather than filing this
// under "notifications fixed."
export interface ExpoPushMessage {
  to: string
  title: string
  body: string
  sound?: 'default' | null
  data?: Record<string, unknown>
  /** Omitted deliberately by default: Expo documents the default as "high" on
   *  iOS already (normal on Android), so setting it changes nothing on the
   *  beta target. Kept as an explicit option rather than a blanket addition,
   *  because adding it everywhere would look like a delivery fix while
   *  changing nothing at all. */
  priority?: 'default' | 'normal' | 'high'
  /** iOS 15+ UNNotificationInterruptionLevel.
   *
   *  RC, 2026-09-05: "the notifications for all of these things are coming
   *  through, but they're coming through very very late... about a half hour
   *  or more."
   *
   *  Measured before changing anything, rather than guessed: two test pushes
   *  to RC's own registered token, one with priority 'high' and one exactly as
   *  the app sends them, were both accepted (ticket status ok) AND both came
   *  back with receipt status "ok" -- Expo handed both to Apple without
   *  complaint. So the delay is NOT in this app's sending code, and adding a
   *  `priority` field would have changed nothing: Expo documents its default
   *  as ALREADY high on iOS.
   *
   *  What holds an accepted push for half an hour is iOS itself batching it --
   *  Scheduled Summary, or a Focus mode. `time-sensitive` is the one thing an
   *  app can set that breaks out of both. It is not free: Apple gates it
   *  behind the com.apple.developer.usernotifications.time-sensitive
   *  entitlement (added to app.json's ios.entitlements in the same change),
   *  and WITHOUT that entitlement iOS silently downgrades the level to
   *  'active' rather than erroring. Both halves ship together or neither
   *  works, and neither reaches RC's phone until a build carries them.
   *
   *  Used only for pushes another PERSON just triggered and is waiting on -- a
   *  duel invite, a folder invite, your move. The daily Reg/Word of the Day
   *  and AD digests are exactly what a notification summary is for and are
   *  deliberately left alone. */
  interruptionLevel?: 'active' | 'critical' | 'passive' | 'time-sensitive'
}

export interface ExpoPushOutcome {
  accepted: number
  failed: number
  /** Distinct `details.error` codes Expo returned, e.g. DeviceNotRegistered. */
  errorCodes: string[]
}

/** POST a batch of push messages and report every ticket-level failure.
 *
 * Batched into ONE request per call: the Expo API takes an array, and a single
 * request also means a single set of tickets to line back up against the
 * messages that produced them. */
export async function sendExpoPushes(
  messages: ExpoPushMessage[],
  context: { feature: string; extra?: Record<string, unknown> },
): Promise<ExpoPushOutcome> {
  const empty: ExpoPushOutcome = { accepted: 0, failed: 0, errorCodes: [] }
  if (messages.length === 0) return empty

  let res: Response
  try {
    res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: context.feature, stage: 'push_fetch' }, extra: context.extra })
    return { ...empty, failed: messages.length, errorCodes: ['NetworkError'] }
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    Sentry.captureMessage('Expo push HTTP error', {
      level: 'warning',
      tags: { feature: context.feature, stage: 'push_http' },
      extra: { ...context.extra, status: res.status, body: text.slice(0, 500) },
    })
    return { ...empty, failed: messages.length, errorCodes: [`HTTP_${res.status}`] }
  }

  let parsed: any
  try { parsed = JSON.parse(text) } catch {
    Sentry.captureMessage('Expo push response was not JSON', {
      level: 'warning',
      tags: { feature: context.feature, stage: 'push_parse' },
      extra: { ...context.extra, body: text.slice(0, 500) },
    })
    return { ...empty, failed: messages.length, errorCodes: ['UnparseableResponse'] }
  }

  // A 200 can still carry a top-level `errors` array (a malformed batch, an
  // over-large request) with no `data` at all.
  const tickets: any[] = Array.isArray(parsed?.data) ? parsed.data : []
  if (tickets.length === 0) {
    Sentry.captureMessage('Expo push returned no tickets', {
      level: 'warning',
      tags: { feature: context.feature, stage: 'push_tickets' },
      extra: { ...context.extra, body: text.slice(0, 500) },
    })
    return { ...empty, failed: messages.length, errorCodes: ['NoTickets'] }
  }

  const out: ExpoPushOutcome = { accepted: 0, failed: 0, errorCodes: [] }
  tickets.forEach((ticket, i) => {
    if (ticket?.status === 'ok') { out.accepted += 1; return }
    out.failed += 1
    const code = ticket?.details?.error ?? 'UnknownTicketError'
    if (!out.errorCodes.includes(code)) out.errorCodes.push(code)
    Sentry.captureMessage(`Expo push rejected: ${code}`, {
      level: 'warning',
      tags: { feature: context.feature, stage: 'push_ticket', expo_error: code },
      extra: {
        ...context.extra,
        // The token is a device credential, not a secret, but there is no
        // reason to ship the whole thing to Sentry -- the tail is enough to
        // tell two devices apart when reading an issue.
        token_tail: messages[i]?.to?.slice(-8) ?? null,
        message: ticket?.message ?? null,
      },
    })
  })
  return out
}
