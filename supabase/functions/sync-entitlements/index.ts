// Verified, server-side entitlement sync — the missing piece behind every
// tier-gated content view (advisory_circulars_gated, etc: see
// gotcha_tier_gate_client_side_only.md). Postgres had no queryable source
// of truth for "is this user currently Plus/Pro/Premium" at all before this
// -- entitlement checks only ever happened client-side against RevenueCat's
// SDK. This function is what keeps user_entitlements current.
//
// Security property that matters most here: this NEVER trusts a
// client-supplied tier claim. It resolves the caller from their own verified
// JWT (same pattern as delete-account), then independently asks RevenueCat's
// own API what THAT specific user's real entitlements are, and writes only
// that. A client calling this with a forged "I'm Premium" body would have no
// effect -- the body isn't even read.
//
// Called by the app: right after a successful purchase/restore (so the gate
// lifts within seconds, not whenever the webhook happens to land), and once
// at sign-in/session-init (self-healing, in case a webhook was ever missed).
// The revenuecat-webhook function is the passive backstop for changes that
// happen while the app isn't open (renewals, expirations, billing issues).
//
// No third-party imports — plain fetch, matches delete-account/
// revenuecat-webhook's own reasoning (avoids remote module resolution at
// cold-start).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// RevenueCat internal entitlement ids (not the app-facing lookup_key
// strings like 'pro'/'premium'/'unlocked' used client-side) -- from
// GET /v2/projects/proj477ce0a7/entitlements, see
// revenuecat_v2_grant_entitlement.md. Stable project-scoped ids, not
// secrets -- the actual secret is RC_SECRET_KEY below.
const RC_PROJECT_ID = 'proj477ce0a7'
const ENTITLEMENT_PRO = 'entl7a1e54b564'
const ENTITLEMENT_PREMIUM = 'entl9a4cd81bee'
const ENTITLEMENT_UNLOCKED = 'entla6876b7d15'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const rcSecretKey = Deno.env.get('RC_SECRET_KEY')!

  // Resolve the calling user from their own session token — never trust a
  // client-supplied user id, same reasoning as delete-account.
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authHeader },
  })
  if (!userRes.ok) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }
  const user = await userRes.json()
  const userId = user?.id
  if (!userId) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  // RevenueCat's appUserID IS the Supabase user id (see revenuecat.ts's
  // Purchases.configure({ appUserID: userId })) — direct lookup, no mapping
  // table needed.
  const rcRes = await fetch(
    `https://api.revenuecat.com/v2/projects/${RC_PROJECT_ID}/customers/${userId}`,
    { headers: { Authorization: `Bearer ${rcSecretKey}` } }
  )

  // A 404 MUST NOT DOWNGRADE ANYONE.
  //
  // RC, B42, on his own Premium account: "as soon as i open B42, i get a popup
  // saying i have to delete an a/c or upgrade to Pro/Prem ... my account was
  // already Prem. This CANNOT happen to real users."
  //
  // This function used to treat 404 as "no entitlements" and fall through to
  // the upsert below, writing is_pro/is_premium/is_unlocked = false over
  // whatever was there. The old comment called that "the correct fail-closed
  // default" -- and it is, for a brand-new signup with no row yet. It is not a
  // default at all for an existing paying customer: merge-duplicates makes it
  // an overwrite, and fleet_visible_cap() then returns 0, which hides every
  // aircraft and puts AircraftDowngradeGate in front of a Premium subscriber
  // demanding they delete their fleet or pay again.
  //
  // 404 does NOT mean "this customer has no entitlements" -- RevenueCat
  // answers 200 with an empty active_entitlements list for a real customer
  // whose subscription lapsed, and that path below still downgrades correctly.
  // 404 means "no customer record found at all", which for someone who has
  // previously paid is an anomaly, never a cancellation signal.
  //
  // Nothing is lost by skipping the write: the on_auth_user_created_entitlements
  // trigger already inserts an all-false row for every new user at signup
  // (verified live 2026-09-09 -- zero users exist without one), so there is no
  // case where this write is the thing creating a missing row.
  //
  // Same shape as gotcha_failed_read_treated_as_deletion.md: an absent read
  // treated as an authoritative negative, destroying real state.
  if (rcRes.status === 404) {
    console.warn(
      `RevenueCat has no customer record for ${userId} -- leaving user_entitlements ` +
      `untouched rather than writing false over a possibly-paid row.`
    )
    return new Response(JSON.stringify({ ok: true, skipped: 'rc_customer_not_found' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

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
  } else {
    // A real RevenueCat API error — don't silently write a false/false/false
    // row over a possibly-still-valid one; fail loudly instead of downgrading
    // someone's real entitlement because of a transient RC API hiccup. (404 is
    // already handled and returned above, so anything reaching here is a
    // genuine error.)
    console.error('RevenueCat lookup failed', rcRes.status, await rcRes.text())
    return new Response('Internal error', { status: 502, headers: corsHeaders })
  }

  const { error } = await fetch(`${supabaseUrl}/rest/v1/user_entitlements`, {
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
  }).then(async (r) => (r.ok ? {} : { error: await r.text() }))

  if (error) {
    console.error('user_entitlements upsert failed', error)
    return new Response('Internal error', { status: 500, headers: corsHeaders })
  }

  return new Response(
    JSON.stringify({ isPro, isPremium, isUnlocked }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
