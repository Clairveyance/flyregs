// RevenueCat webhook receiver — logs subscription lifecycle events for
// analytics (subscription_events table). Does not gate any app feature;
// entitlement checks at read time still go straight to RevenueCat.
//
// Configure in RevenueCat dashboard: Project Settings > Integrations > Webhooks
//   URL: https://<project-ref>.supabase.co/functions/v1/revenuecat-webhook
//   Authorization header value: the RC_WEBHOOK_SECRET set on this function
//
// No third-party imports — plain fetch to PostgREST, to avoid remote
// module resolution at cold-start (esm.sh/jsr imports caused BOOT_ERROR
// when deployed via the Management API's single-file deploy endpoint).

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

  return new Response('OK', { status: 200 })
})
