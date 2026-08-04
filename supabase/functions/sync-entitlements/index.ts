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
  // table needed. A brand-new signup who's never opened the native app has
  // no RevenueCat customer record yet — that's a 404, treated as "no
  // entitlements" below, which is the correct fail-closed default anyway.
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
    // A real RevenueCat API error (not just "no customer yet") — don't
    // silently write a false/false/false row over a possibly-still-valid
    // one; fail loudly instead of downgrading someone's real entitlement
    // because of a transient RC API hiccup.
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
