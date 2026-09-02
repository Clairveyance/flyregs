// Self-service account deletion — Apple Guideline 5.1.1(v) requires true
// in-app deletion, not a manual/email-based process. Called from the app
// with the user's own session (supabase.functions.invoke sends it as the
// Authorization bearer automatically); this function resolves that token to
// a user id, then deletes their avatar and the auth user itself.
//
// Deleting the auth user cascades (ON DELETE CASCADE) to every app table
// that references it — synced_bookmarks, synced_folders, synced_folder_items,
// synced_notes, folder_collaborators, aircraft_collaborators, push_tokens,
// user_bookmarks, user_aircraft, user_aircraft_reminders,
// user_ad_notifications, callsign_registry — so no manual per-table cleanup
// is needed here. (aircraft_collaborators.user_id was missing this FK until
// sync/migrations_aircraft_collaborators_user_fk.sql, 2026-08-09 — before
// that, a collaborator deleting their account left a dangling row behind.)
// Storage objects are NOT covered by that cascade, so the avatar is removed
// explicitly first.
//
// No third-party imports — plain fetch to GoTrue/Storage/PostgREST, to avoid
// remote module resolution at cold-start (matches revenuecat-webhook).

// CORS — the app also ships a web build, and browsers preflight any
// cross-origin request carrying a custom Authorization header.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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

  // Resolve the calling user from their own session token — never trust a
  // client-supplied user id for a destructive operation like this.
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

  const svcHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  }

  // Best-effort avatar cleanup — a missing object is not an error.
  await fetch(`${supabaseUrl}/storage/v1/object/avatars/${userId}/avatar.jpg`, {
    method: 'DELETE',
    headers: svcHeaders,
  }).catch(() => {})

  // Aircraft photos, 2026-09-03. This header already said "Storage objects are
  // NOT covered by that cascade" and then cleaned ONLY the avatar. Aircraft
  // photos live at aircraft-images/<aircraftId>/photo-<hash>.jpg — keyed by
  // AIRCRAFT id, not user id — and `aircraft-images` is a PUBLIC bucket
  // (verified live: storage.buckets.public = true). So on deletion
  // user_aircraft cascades away, taking image_path with it, and the object is
  // left anonymously fetchable forever with no row anywhere that could ever
  // locate it again. The user was told "This permanently deletes your account
  // and all synced data", and an aircraft photo shows a tail number.
  //
  // Must run BEFORE the auth-user delete: the cascade destroys the only
  // pointers to these objects.
  try {
    const acRes = await fetch(
      `${supabaseUrl}/rest/v1/user_aircraft?user_id=eq.${userId}&image_path=not.is.null&select=image_path`,
      { headers: svcHeaders },
    )
    if (acRes.ok) {
      const rows: { image_path: string }[] = await acRes.json()
      for (const r of rows) {
        if (!r.image_path) continue
        await fetch(`${supabaseUrl}/storage/v1/object/aircraft-images/${r.image_path}`, {
          method: 'DELETE',
          headers: svcHeaders,
        }).catch(() => {})
      }
    }
  } catch (e) {
    console.error('aircraft image cleanup failed', e)
  }

  // Feedback identifiers, 2026-09-03. feedback_submissions.user_id is
  // ON DELETE SET NULL, which clears the uuid but NOT `user_email` — a plain
  // text column holding the address verbatim, still sitting next to the user's
  // free-text message and their uploaded screenshot. Redact the identifier so
  // a deleted account leaves none behind, while the support record itself
  // survives as a legitimate business record.
  await fetch(`${supabaseUrl}/rest/v1/feedback_submissions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_email: null }),
  }).catch(() => {})

  const deleteRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })
  if (!deleteRes.ok) {
    console.error('admin user delete failed', deleteRes.status, await deleteRes.text())
    return new Response('Internal error', { status: 500, headers: corsHeaders })
  }

  return new Response('OK', { status: 200, headers: corsHeaders })
})
