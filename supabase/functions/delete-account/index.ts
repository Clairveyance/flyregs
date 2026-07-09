// Self-service account deletion — Apple Guideline 5.1.1(v) requires true
// in-app deletion, not a manual/email-based process. Called from the app
// with the user's own session (supabase.functions.invoke sends it as the
// Authorization bearer automatically); this function resolves that token to
// a user id, then deletes their avatar and the auth user itself.
//
// Deleting the auth user cascades (ON DELETE CASCADE) to every app table
// that references it — synced_bookmarks, synced_folders, synced_folder_items,
// synced_notes, folder_collaborators, push_tokens, user_bookmarks — so no
// manual per-table cleanup is needed here. Storage objects are NOT covered
// by that cascade, so the avatar is removed explicitly first.
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

  // Best-effort avatar cleanup — a missing object is not an error.
  await fetch(`${supabaseUrl}/storage/v1/object/avatars/${userId}/avatar.jpg`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
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
