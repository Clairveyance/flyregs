// One place that actually knows whether a push was DELIVERED.
//
// WHY THIS EXISTS
// RC, repeatedly, over weeks: notifications don't arrive, and each time he was
// told it was fixed. The reason that claim could never be trusted is that
// nothing in the system ever knew. All five senders did this:
//
//     POST /push/send  ->  if (ticket.status === 'error') console.error(...)
//     console.log('Done.')
//
// An Expo TICKET only means "Expo accepted this for delivery". Whether APNs
// actually took it is reported separately, in a RECEIPT, which must be fetched
// by id afterwards. Nothing fetched receipts. So a token that APNs had revoked
// (DeviceNotRegistered), a credentials problem (InvalidCredentials /
// MismatchSenderId -- which silently breaks EVERY push at once), or throttling
// all looked identical to success: "Sending to N device(s). Done."
//
// A sender that cannot distinguish delivered from discarded cannot be
// described as fixed. This module makes that distinction, out loud.
//
// WHAT IT DOES
//   * sends in Expo's documented batches of 100
//   * keeps each ticket id paired with the token it was for
//   * fetches receipts, with retries, because a receipt is not instant
//   * prints a per-error-code summary instead of a bare "Done."
//   * prunes DeviceNotRegistered tokens, which is Expo's own prescribed
//     remedy -- an unpruned dead token fails forever and silently
//   * returns a summary so a caller can exit non-zero on a SYSTEMIC failure
//     (bad credentials) while tolerating one dead handset
//
// HONEST LIMIT, stated rather than hidden: Expo does not guarantee a receipt
// is ready immediately. Anything still unresolved when the retries run out is
// reported as `pending` -- NOT counted as delivered. "We don't know yet" is a
// legitimate answer; "Done." was not.

const SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const SEND_BATCH = 100
const RECEIPT_BATCH = 300

// Error codes that mean the whole pipeline is broken rather than one handset.
// If these appear, every push in the run is suspect and the caller should fail
// loudly rather than report a successful run.
const SYSTEMIC = new Set(['InvalidCredentials', 'MismatchSenderId'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param messages  [{ to, title, body, data?, sound?, ... }]
 * @param opts.sb   optional supabase client; enables DeviceNotRegistered pruning
 * @param opts.label short name for log lines ("DailyReg", "AD alerts", ...)
 * @param opts.receiptWaits  ms to wait before each receipt attempt
 */
export async function sendExpoPush(messages, { sb = null, label = 'push', receiptWaits = [4000, 8000, 15000] } = {}) {
  const summary = {
    attempted: messages.length,
    accepted: 0,
    delivered: 0,
    pending: 0,
    failed: 0,
    byError: {},
    systemic: false,
  }
  if (!messages.length) {
    console.log(`${label}: nothing to send.`)
    return summary
  }

  // ticket id -> token, so a receipt error can name the device it belongs to.
  const ticketToToken = new Map()

  for (let i = 0; i < messages.length; i += SEND_BATCH) {
    const chunk = messages.slice(i, i + SEND_BATCH)
    let res
    try {
      res = await fetch(SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      })
    } catch (e) {
      console.error(`${label}: push/send threw for batch at ${i}: ${e.message}`)
      summary.failed += chunk.length
      continue
    }
    if (!res.ok) {
      console.error(`${label}: push/send returned HTTP ${res.status} for batch at ${i}`)
      summary.failed += chunk.length
      continue
    }
    const json = await res.json()
    const data = json.data ?? []
    data.forEach((t, idx) => {
      const token = chunk[idx]?.to
      if (t.status === 'ok' && t.id) {
        summary.accepted += 1
        ticketToToken.set(t.id, token)
      } else {
        summary.failed += 1
        const code = t.details?.error ?? t.message ?? 'unknown'
        summary.byError[code] = (summary.byError[code] ?? 0) + 1
        if (SYSTEMIC.has(code)) summary.systemic = true
        console.error(`${label}: ticket rejected for ${short(token)} -- ${code}`)
      }
    })
  }

  // --- receipts: the half that never existed ---
  let outstanding = [...ticketToToken.keys()]
  const deadTokens = new Set()

  for (const wait of receiptWaits) {
    if (!outstanding.length) break
    await sleep(wait)
    const stillOutstanding = []
    for (let i = 0; i < outstanding.length; i += RECEIPT_BATCH) {
      const ids = outstanding.slice(i, i + RECEIPT_BATCH)
      let res
      try {
        res = await fetch(RECEIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ids }),
        })
      } catch (e) {
        console.error(`${label}: getReceipts threw: ${e.message}`)
        stillOutstanding.push(...ids)
        continue
      }
      if (!res.ok) {
        console.error(`${label}: getReceipts returned HTTP ${res.status}`)
        stillOutstanding.push(...ids)
        continue
      }
      const json = await res.json()
      const got = json.data ?? {}
      for (const id of ids) {
        const r = got[id]
        if (!r) { stillOutstanding.push(id); continue }   // not ready yet
        if (r.status === 'ok') {
          summary.delivered += 1
        } else {
          summary.failed += 1
          const code = r.details?.error ?? 'unknown'
          summary.byError[code] = (summary.byError[code] ?? 0) + 1
          if (SYSTEMIC.has(code)) summary.systemic = true
          const token = ticketToToken.get(id)
          if (code === 'DeviceNotRegistered' && token) deadTokens.add(token)
          console.error(`${label}: NOT delivered to ${short(ticketToToken.get(id))} -- ${code}${r.message ? ` (${r.message})` : ''}`)
        }
      }
    }
    outstanding = stillOutstanding
  }
  summary.pending = outstanding.length

  // Expo's own prescribed remedy. An unpruned revoked token fails forever, and
  // silently -- exactly the state this module exists to end.
  if (sb && deadTokens.size) {
    const { error } = await sb.from('push_tokens').delete().in('expo_push_token', [...deadTokens])
    if (error) console.error(`${label}: could not prune ${deadTokens.size} dead token(s): ${error.message}`)
    else console.log(`${label}: pruned ${deadTokens.size} token(s) APNs has revoked (DeviceNotRegistered).`)
  }

  const parts = [
    `${summary.attempted} attempted`,
    `${summary.delivered} delivered`,
    summary.pending ? `${summary.pending} still pending` : null,
    summary.failed ? `${summary.failed} FAILED` : null,
  ].filter(Boolean)
  console.log(`${label}: ${parts.join(', ')}.`)
  if (Object.keys(summary.byError).length) {
    console.log(`${label}: failures by cause -> ${JSON.stringify(summary.byError)}`)
  }
  if (summary.systemic) {
    console.error(`${label}: SYSTEMIC push failure (credentials/sender mismatch) -- every push this run is suspect.`)
  }
  return summary
}

function short(token) {
  if (!token) return 'unknown device'
  return String(token).slice(0, 24) + '…'
}

/**
 * Fetch Expo receipts for ticket ids and report a verdict per id.
 * Split out so a sender with its own per-recipient bookkeeping (AD alerts,
 * reminders) can keep that bookkeeping and still learn what APNs did.
 *
 * @returns Map<ticketId, { status: 'ok' | 'error' | 'pending', code?: string }>
 *          'pending' means Expo had no answer yet -- deliberately NOT 'ok'.
 */
export async function checkExpoReceipts(ids, { label = 'push', receiptWaits = [4000, 8000, 15000] } = {}) {
  const verdicts = new Map()
  let outstanding = [...ids]
  for (const wait of receiptWaits) {
    if (!outstanding.length) break
    await sleep(wait)
    const still = []
    for (let i = 0; i < outstanding.length; i += RECEIPT_BATCH) {
      const batch = outstanding.slice(i, i + RECEIPT_BATCH)
      let res
      try {
        res = await fetch(RECEIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ids: batch }),
        })
      } catch (e) {
        console.error(`${label}: getReceipts threw: ${e.message}`)
        still.push(...batch); continue
      }
      if (!res.ok) {
        console.error(`${label}: getReceipts returned HTTP ${res.status}`)
        still.push(...batch); continue
      }
      const got = (await res.json()).data ?? {}
      for (const id of batch) {
        const r = got[id]
        if (!r) { still.push(id); continue }
        if (r.status === 'ok') verdicts.set(id, { status: 'ok' })
        else {
          const code = r.details?.error ?? 'unknown'
          verdicts.set(id, { status: 'error', code })
          console.error(`${label}: NOT delivered -- ${code}${r.message ? ` (${r.message})` : ''}`)
        }
      }
    }
    outstanding = still
  }
  for (const id of outstanding) verdicts.set(id, { status: 'pending' })
  if (outstanding.length) {
    console.log(`${label}: ${outstanding.length} receipt(s) still pending -- recorded as unconfirmed, not delivered.`)
  }
  return verdicts
}
