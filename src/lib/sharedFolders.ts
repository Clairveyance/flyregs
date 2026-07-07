import { supabase } from '@/lib/supabase'

// Real folder sharing: an owner generates an invite link, anyone who redeems
// it gets read-only access to that folder's AC bookmarks (not notes -- see
// the migration's comment for why) across their own devices. Collaborators
// still need their own Pro/Premium subscription to see full AC text -- this
// only shares which ACs to look at, never bypasses the paywall.

export interface SharedFolderSummary {
  folder_id: string
  folder_name: string
}

function makeShareToken(): string {
  return Array.from({ length: 24 }, () => Math.random().toString(36)[2] ?? '0').join('')
}

// Deep link opened via the app's own URL scheme (see app.json's "scheme").
// Requires the recipient to already have FlyRegs installed -- a universal
// link with a smart web fallback would be a nicer v2, but needs hosting an
// apple-app-site-association file on the website, which is separate scope.
export function buildShareLink(token: string): string {
  return `flyregs://join/${token}`
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
  const { data: memberships } = await supabase.from('folder_collaborators').select('folder_id')
  const folderIds = (memberships ?? []).map((m) => m.folder_id)
  if (!folderIds.length) return []

  const { data: folders } = await supabase.from('synced_folders').select('id, name').in('id', folderIds)
  return (folders ?? []).map((f) => ({ folder_id: f.id, folder_name: f.name }))
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
