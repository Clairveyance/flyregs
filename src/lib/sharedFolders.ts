import { supabase } from '@/lib/supabase'
import { syncPushFolder, syncPushFolderItems, syncPushNote } from '@/lib/syncPush'
import { getFolders, getItemsInFolder, markFolderShared } from '@/lib/folders'
import { getNotes } from '@/lib/notes'

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
//
// Sharing is a per-folder Premium decision, not a whole-library one -- a user
// who has never turned on the separate, global "Back up & sync" toggle can
// still share a folder. On first share, this force-pushes exactly the rows a
// collaborator needs (the folder itself, its item pointers, and the content
// of any notes among those items -- notes aren't in a public reference table
// like ACs are, so their actual title/body has to reach the cloud too) past
// that toggle, then marks the folder locally so every later mutation to it
// (add/remove items) keeps force-pushing too. See folders.ts's Folder.shared
// and syncPush.ts's `force` param.
export async function getOrCreateShareLink(folderId: string): Promise<string> {
  const { data: existing } = await supabase
    .from('synced_folders')
    .select('share_token')
    .eq('id', folderId)
    .maybeSingle()

  if (existing?.share_token) return buildShareLink(existing.share_token)

  const [folders, items, notes] = await Promise.all([getFolders(), getItemsInFolder(folderId), getNotes()])
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) throw new Error('Folder not found')

  await syncPushFolder(folder, true)
  if (items.length) await syncPushFolderItems(items, true)
  const noteMap = new Map(notes.map((n) => [n.id, n]))
  const noteItems = items.filter((i) => i.item_type === 'note').map((i) => noteMap.get(i.item_id))
  await Promise.all(noteItems.filter((n): n is NonNullable<typeof n> => !!n).map((n) => syncPushNote(n, true)))
  await markFolderShared(folderId)

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
    .is('left_at', null)
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
// user has generated an invite link for, with however many collaborators
// have joined so far (0 is a normal, expected count, not an error state).
//
// Deliberately keyed off share_token existing on synced_folders, NOT off
// having a folder_collaborators row -- generating the invite link
// (getOrCreateShareLink) never creates a collaborator row by itself, only
// someone actually redeeming it does. Querying folder_collaborators here
// meant a freshly-shared folder with 0 joiners so far was invisible in From
// Me until someone joined, instead of showing up the moment it was shared
// (so the owner has somewhere to manage/revoke/watch it from immediately).
export async function getMySharedFolders(): Promise<SharedByMeFolder[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: folders } = await supabase
    .from('synced_folders')
    .select('id, name')
    .eq('user_id', user.id)
    .eq('deleted', false)
    .not('share_token', 'is', null)
  if (!folders?.length) return []

  const folderIds = folders.map((f) => f.id)
  const { data: rows } = await supabase
    .from('folder_collaborators')
    .select('folder_id')
    .eq('owner_id', user.id)
    .in('folder_id', folderIds)
    .is('left_at', null)

  const counts = new Map<string, number>()
  for (const r of rows ?? []) counts.set(r.folder_id, (counts.get(r.folder_id) ?? 0) + 1)

  return folders.map((f) => ({
    folder_id: f.id,
    folder_name: f.name,
    collaboratorCount: counts.get(f.id) ?? 0,
  }))
}

export interface SharedFolderACItem {
  item_id: string
}

export async function getSharedFolderACItems(folderId: string): Promise<SharedFolderACItem[]> {
  const { data } = await supabase
    .from('synced_folder_items')
    .select('item_id')
    .eq('folder_id', folderId)
    .eq('item_type', 'ac')
    .eq('deleted', false)
  return data ?? []
}

export interface SharedFolderNoteItem {
  item_id: string
}

// Notes used to be silently excluded from shared folders -- synced_notes
// only had an owner-only RLS policy, so even though a collaborator could see
// the folder_item row referencing a note, they had no way to actually read
// its title/body. Fixed with a new `collaborators_read_shared_notes` policy
// on synced_notes (scoped to exactly the notes referenced by folders this
// user has joined) -- this just reads the item pointers the same way
// getSharedFolderACItems does; see folder/shared/[id].tsx for the note
// content fetch itself.
export async function getSharedFolderNoteItems(folderId: string): Promise<SharedFolderNoteItem[]> {
  const { data } = await supabase
    .from('synced_folder_items')
    .select('item_id')
    .eq('folder_id', folderId)
    .eq('item_type', 'note')
    .eq('deleted', false)
  return data ?? []
}

// Soft-marks left_at rather than deleting the row, so the owner can see who
// left (a real, meaningful state) instead of them just silently vanishing
// from the collaborator list with no trace. join_shared_folder's own
// ON CONFLICT clears left_at back to null on rejoin, so tapping the same
// invite link again correctly reactivates the same row.
export async function leaveSharedFolder(folderId: string): Promise<void> {
  await supabase.from('folder_collaborators').update({ left_at: new Date().toISOString() }).eq('folder_id', folderId)
}

export interface FolderCollaborator {
  userId: string
  /** The collaborator's chosen handle (Account > User Handle), falling back
   * to the local part of their email if they haven't set one -- never the
   * full email/domain, matching get_shared_folder_owners' own fallback. */
  displayLabel: string
  joinedAt: string
  /** Set once this person has left (soft-marked, not deleted) -- null while
   * still an active member. */
  leftAt: string | null
  /** Set once this person has opened the folder at least once -- same field
   * that drives the With Me unread dot, reused here as the owner-facing
   * "has this person actually looked at it yet" signal. */
  lastViewedAt: string | null
}

export async function getFolderCollaborators(folderId: string): Promise<FolderCollaborator[]> {
  const { data, error } = await supabase.rpc('get_folder_collaborators', { p_folder_id: folderId })
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    userId: row.out_user_id,
    displayLabel: row.out_display_label,
    joinedAt: row.out_joined_at,
    leftAt: row.out_left_at,
    lastViewedAt: row.out_last_viewed_at,
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
