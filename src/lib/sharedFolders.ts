import { supabase } from '@/lib/supabase'

// Real folder sharing: an owner generates an invite link, anyone who redeems
// it gets read-only access to that folder's AC bookmarks (not notes -- see
// the migration's comment for why) across their own devices. Collaborators
// still need their own Pro/Premium subscription to see full AC text -- this
// only shares which ACs to look at, never bypasses the paywall.

export interface SharedFolderSummary {
  folder_id: string
  folder_name: string
  ownerAvatarUrl?: string | null
  ownerAvatarPreset?: string | null
  ownerDisplayName?: string | null
  /** True until the collaborator opens this folder once -- drives the blue
   * unread dot in With Me, matching the unread-email convention. Never
   * re-appears after the first open, even if the owner adds more ACs later. */
  isUnread?: boolean
}

function makeShareToken(): string {
  return Array.from({ length: 24 }, () => Math.random().toString(36)[2] ?? '0').join('')
}

// Routes through a flyregs.com/join/{token} landing page rather than the raw
// flyregs:// custom scheme -- if the recipient doesn't have the app
// installed, a bare custom-scheme link fails silently with no prompt. The
// web page attempts the same custom-scheme handoff itself and falls back to
// an App Store link if that fails. See the app's own src/app/join/[token].tsx
// for the in-app handler this ultimately hands off to.
export function buildShareLink(token: string): string {
  return `https://flyregs.com/join/${token}`
}

// Returns the existing share link if this folder already has one, generating
// it on first share so re-sharing the same folder always gives the same link.
export async function getOrCreateShareLink(folderId: string): Promise<string> {
  const { data: existing } = await supabase
    .from('synced_folders')
    .select('share_token')
    .eq('id', folderId)
    .maybeSingle()

  if (existing?.share_token) return buildShareLink(existing.share_token)

  const token = makeShareToken()
  const { error } = await supabase.from('synced_folders').update({ share_token: token }).eq('id', folderId)
  if (error) throw error
  return buildShareLink(token)
}

export async function joinSharedFolder(token: string): Promise<SharedFolderSummary> {
  const { data, error } = await supabase.rpc('join_shared_folder', { p_token: token })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('Invalid or expired invite link')
  return { folder_id: row.out_folder_id, folder_name: row.out_folder_name }
}

export async function getMyCollaborations(): Promise<SharedFolderSummary[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  // folder_collaborators has two RLS policies (one for the collaborator, one
  // for the owner) that combine with OR -- a user who both owns shared
  // folders AND has joined someone else's would otherwise get both mixed
  // into one unfiltered select. Explicitly scope to rows where THIS user is
  // the joining collaborator, not the owner.
  const { data: memberships } = await supabase
    .from('folder_collaborators')
    .select('folder_id, last_viewed_at')
    .eq('user_id', user.id)
  const folderIds = (memberships ?? []).map((m) => m.folder_id)
  if (!folderIds.length) return []
  const unreadMap = new Map((memberships ?? []).map((m) => [m.folder_id, m.last_viewed_at == null]))

  // Exclude folders the owner has since (soft-)deleted -- deleteFolder() only
  // flips a `deleted` flag rather than removing the row, so without this
  // filter a collaborator would keep seeing a folder the owner thinks is gone.
  const { data: folders } = await supabase
    .from('synced_folders')
    .select('id, name')
    .in('id', folderIds)
    .eq('deleted', false)
  if (!folders?.length) return []

  // Best-effort: owner avatar/name is a nice-to-have, not load-bearing --
  // if this RPC fails for any reason, still show the folders themselves.
  const { data: owners } = await supabase
    .rpc('get_shared_folder_owners', { p_folder_ids: folders.map((f) => f.id) })
    .then((res) => res, () => ({ data: null as any[] | null }))
  const ownerMap = new Map<string, { avatarUrl: string | null; avatarPreset: string | null; displayName: string | null }>(
    (owners ?? []).map((o: any) => [
      o.out_folder_id,
      { avatarUrl: o.out_owner_avatar_url, avatarPreset: o.out_owner_avatar_preset, displayName: o.out_owner_display_name },
    ])
  )

  return folders.map((f) => ({
    folder_id: f.id,
    folder_name: f.name,
    ownerAvatarUrl: ownerMap.get(f.id)?.avatarUrl ?? null,
    ownerAvatarPreset: ownerMap.get(f.id)?.avatarPreset ?? null,
    ownerDisplayName: ownerMap.get(f.id)?.displayName ?? null,
    isUnread: unreadMap.get(f.id) ?? false,
  }))
}

// Called once when a collaborator actually opens a shared folder -- clears
// the unread dot permanently (see SharedFolderSummary.isUnread comment).
export async function markSharedFolderViewed(folderId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  await supabase
    .from('folder_collaborators')
    .update({ last_viewed_at: new Date().toISOString() })
    .eq('folder_id', folderId)
    .eq('user_id', user.id)
}

export interface SharedByMeFolder extends SharedFolderSummary {
  collaboratorCount: number
}

// The owner-facing counterpart to getMyCollaborations -- every folder this
// user owns that currently has at least one collaborator, with a count, so
// they don't have to open each folder individually to see what's shared.
export async function getMySharedFolders(): Promise<SharedByMeFolder[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: rows } = await supabase
    .from('folder_collaborators')
    .select('folder_id')
    .eq('owner_id', user.id)
  if (!rows?.length) return []

  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.folder_id, (counts.get(r.folder_id) ?? 0) + 1)
  const folderIds = [...counts.keys()]

  const { data: folders } = await supabase
    .from('synced_folders')
    .select('id, name')
    .in('id', folderIds)
    .eq('deleted', false)
  return (folders ?? []).map((f) => ({
    folder_id: f.id,
    folder_name: f.name,
    collaboratorCount: counts.get(f.id) ?? 0,
  }))
}

// Revokes sharing entirely: removes every collaborator and invalidates the
// share link (a new one is generated next time the owner shares again). The
// folder itself and its contents are untouched -- this only undoes sharing,
// it's not folder deletion.
export async function unshareFolder(folderId: string): Promise<void> {
  await supabase.from('folder_collaborators').delete().eq('folder_id', folderId)
  await supabase.from('synced_folders').update({ share_token: null }).eq('id', folderId)
}

export interface SharedFolderACItem {
  item_id: string
}

// V1 scope: only AC items resolve for a collaborator. Note-type items in a
// shared folder are silently excluded here, not shown as broken/empty --
// see the migration file for why.
export async function getSharedFolderACItems(folderId: string): Promise<SharedFolderACItem[]> {
  const { data } = await supabase
    .from('synced_folder_items')
    .select('item_id')
    .eq('folder_id', folderId)
    .eq('item_type', 'ac')
    .eq('deleted', false)
  return data ?? []
}

export async function leaveSharedFolder(folderId: string): Promise<void> {
  await supabase.from('folder_collaborators').delete().eq('folder_id', folderId)
}

export interface FolderCollaborator {
  userId: string
  email: string
  joinedAt: string
}

export async function getFolderCollaborators(folderId: string): Promise<FolderCollaborator[]> {
  const { data, error } = await supabase.rpc('get_folder_collaborators', { p_folder_id: folderId })
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    userId: row.out_user_id,
    email: row.out_email,
    joinedAt: row.out_joined_at,
  }))
}

export async function removeCollaborator(folderId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('folder_collaborators')
    .delete()
    .eq('folder_id', folderId)
    .eq('user_id', userId)
  if (error) throw error
}
