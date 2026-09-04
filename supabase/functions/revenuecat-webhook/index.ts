// RevenueCat webhook receiver — logs subscription lifecycle events for
// analytics (subscription_events table), AND keeps user_entitlements (the
// DB-backed tier-of-record behind every *_gated view/RPC — see
// gotcha_tier_gate_client_side_only.md) current as a passive backstop for
// changes that happen while the app isn't open: renewals, expirations,
// billing issues, cancellations. sync-entitlements is the active path
// (called right after purchase/restore and at session-init); this is what
// covers everything in between.
//
// Deliberately does NOT try to interpret event.type / event.entitlement_ids
// to decide what changed — RevenueCat's event taxonomy has too many shapes
// (RENEWAL vs EXPIRATION vs BILLING_ISSUE vs PRODUCT_CHANGE vs TRANSFER all
// describe "what happened" differently) to reliably derive current state
// from. Instead the event is only ever used as a pointer ("re-check this
// user"), then the current truth is re-fetched from RevenueCat's own
// customer endpoint — identical approach and identical trust model to
// sync-entitlements (never trust a claim, only a fresh authoritative
// lookup). If that re-fetch fails, the event is still logged for analytics;
// only the entitlements upsert is skipped, so a transient RC API hiccup
// never breaks the original analytics-logging duty of this function.
//
// Configure in RevenueCat dashboard: Project Settings > Integrations > Webhooks
//   URL: https://<project-ref>.supabase.co/functions/v1/revenuecat-webhook
//   Authorization header value: the RC_WEBHOOK_SECRET set on this function
//
// No third-party imports — plain fetch to PostgREST, to avoid remote
// module resolution at cold-start (esm.sh/jsr imports caused BOOT_ERROR
// when deployed via the Management API's single-file deploy endpoint).

// Same RevenueCat internal entitlement ids as sync-entitlements — see
// revenuecat_v2_grant_entitlement.md. Not secrets; RC_SECRET_KEY is.
const RC_PROJECT_ID = 'proj477ce0a7'
const ENTITLEMENT_PRO = 'entl7a1e54b564'
const ENTITLEMENT_PREMIUM = 'entl9a4cd81bee'
const ENTITLEMENT_UNLOCKED = 'entla6876b7d15'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function syncEntitlements(
  supabaseUrl: string,
  serviceRoleKey: string,
  rcSecretKey: string,
  userId: string
): Promise<boolean> {
  const rcRes = await fetch(
    `https://api.revenuecat.com/v2/projects/${RC_PROJECT_ID}/customers/${userId}`,
    { headers: { Authorization: `Bearer ${rcSecretKey}` } }
  )

  let isPro = false
  let isPremium = false
  let isUnlocked = false

  if (rcRes.status === 200) {
    const customer = await rcRes.json()
    const activeIds = new Set(
      (customer?.active_entitlements?.items ?? []).map((e: any) => e.entitlement_id)
    )
    isPro = activeIds.has(ENTITLEMENT_PRO)
    isPremium = activeIds.has(ENTITLEMENT_PREMIUM)
    isUnlocked = activeIds.has(ENTITLEMENT_UNLOCKED)
  } else if (rcRes.status !== 404) {
    // 404 is a real answer ("RC has no customer record") and correctly means
    // no entitlements. Anything else is an outage, NOT a downgrade -- falling
    // through here would write is_pro=false over a paying customer.
    console.error('webhook: RevenueCat re-fetch failed', rcRes.status, await rcRes.text())
    return false
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/user_entitlements`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      user_id: userId,
      is_pro: isPro,
      is_premium: isPremium,
      is_unlocked: isUnlocked,
      updated_at: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    console.error('webhook: user_entitlements upsert failed', res.status, await res.text())
    return false
  }
  return true
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const expectedAuth = Deno.env.get('RC_WEBHOOK_SECRET')
  const gotAuth = req.headers.get('authorization')
  if (!expectedAuth || gotAuth !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  const event = body?.event
  if (!event?.id || !event?.type) {
    return new Response('Bad request', { status: 400 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const row = {
    event_id: event.id,
    event_type: event.type,
    app_user_id: event.app_user_id ?? null,
    product_id: event.product_id ?? null,
    entitlement_ids: event.entitlement_ids ?? null,
    period_type: event.period_type ?? null,
    price: event.price ?? null,
    currency: event.currency ?? null,
    environment: event.environment ?? null,
    event_timestamp: event.event_timestamp_ms
      ? new Date(event.event_timestamp_ms).toISOString()
      : null,
    raw: body,
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/subscription_events?on_conflict=event_id`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    }
  )

  if (!res.ok) {
    console.error('subscription_events insert failed', res.status, await res.text())
    return new Response('Internal error', { status: 500 })
  }

  // Entitlements sync. This USED to be "best-effort, never fails the webhook":
  // every failure path was swallowed and the function still answered 200, so
  // RevenueCat marked the webhook delivered and never retried. The failure that
  // mattered is the one nobody would see -- a RENEWAL or INITIAL_PURCHASE whose
  // user_entitlements upsert failed left a user who had genuinely paid with no
  // Pro access and nothing anywhere to retry it. The only self-correction was
  // that user happening to cold-launch the app again.
  //
  // Answering 500 so RevenueCat retries is safe here, and the "never fail the
  // webhook" caution it replaces was already unnecessary: this endpoint is
  // idempotent end to end. subscription_events.event_id carries a UNIQUE index
  // and the insert above is on_conflict=event_id / ignore-duplicates, so a
  // redelivery cannot double-log; and syncEntitlements re-fetches CURRENT truth
  // from RC's customer API rather than applying a delta, so running it twice
  // lands on the same answer. Verified both live 2026-09-03.
  //
  // event.app_user_id is RC's own field, populated from the trusted webhook
  // payload (authenticated above via RC_WEBHOOK_SECRET), not client input.
  const rcSecretKey = Deno.env.get('RC_SECRET_KEY')
  let syncFailed = false
  if (rcSecretKey && event.app_user_id && UUID_RE.test(event.app_user_id)) {
    try {
      if (!(await syncEntitlements(supabaseUrl, serviceRoleKey, rcSecretKey, event.app_user_id))) {
        syncFailed = true
      }
    } catch (err) {
      console.error('webhook: syncEntitlements threw', err)
      syncFailed = true
    }
  }

  // TRANSFER is the one event type this file's own header comment doesn't
  // fully cover -- found in the 2026-08-29 "built but inert" sweep.
  // RevenueCat's own docs: "The webhook is sent only for the destination
  // user [event.app_user_id, re-synced above], although the event appears
  // in both customer histories" -- the SOURCE account (event.transferred_
  // from) never gets a webhook call of its own for this event. Real Apple-
  // ID-level "restore purchases while signed into a different FlyRegs
  // account" transfers an active subscription away from whoever held it,
  // but without this, that departing account's user_entitlements row was
  // never touched -- full server-side access with no subscription behind
  // it, permanently, until that account happened to sign in again (the
  // cold-launch sync-entitlements path this same sweep just fixed a gap in
  // above). Re-syncing every id here re-fetches each one's CURRENT truth
  // from RC's own customer API (same trust model as every other event --
  // see this file's header comment), so it correctly lands on "no longer
  // entitled" rather than assuming that outcome.
  if (rcSecretKey && event.type === 'TRANSFER' && Array.isArray(event.transferred_from)) {
    for (const sourceId of event.transferred_from) {
      if (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)) continue
      try {
        if (!(await syncEntitlements(supabaseUrl, serviceRoleKey, rcSecretKey, sourceId))) {
          syncFailed = true
        }
      } catch (err) {
        console.error('webhook: syncEntitlements (transferred_from) threw', err)
        syncFailed = true
      }
    }
  }

  if (syncFailed) {
    // The event itself is safely logged; only the entitlement write failed.
    // 500 asks RevenueCat to redeliver, which is the only retry this path has.
    console.error('webhook: entitlements sync failed — returning 500 so RevenueCat retries')
    return new Response('Entitlements sync failed', { status: 500 })
  }

  return new Response('OK', { status: 200 })
})
