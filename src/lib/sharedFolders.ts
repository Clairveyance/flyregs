import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { syncPushFolder, syncPushFolderItems, syncPushNote, syncPushBookmark } from '@/lib/syncPush'
import { getFolders, getItemsInFolder, markFolderShared, FolderItem, FolderItemType } from '@/lib/folders'
import { getNotes, isSeedNote } from '@/lib/notes'
import type { Note } from '@/lib/notes'
import { getBookmarks } from '@/lib/bookmarks'
import type { BookmarkAC } from '@/lib/bookmarks'

function makeItemId(): string {
  return `item-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

// Real folder sharing: an owner generates an invite link, anyone who redeems
// it gets access to that folder's bookmarks and notes across their own
// devices -- read-only by default, or read/write if the owner sets it so.
// Per BB-077 (migrations_per_invitee_collab_mode.sql), access is a role on
// the PERSON (folder_collaborators.collab_mode, one row per invitee), not a
// single flag on the folder -- synced_folders.collab_mode is only the
// default a brand-new invite starts at, so the same collaborator can be a
// viewer on one shared folder and an editor on another, AND two different
// collaborators on the SAME folder can independently be read_only vs.
// read_write. Collaborators still need their own Pro/Premium subscription
// to see full AC/FAR/AIM/etc. text -- this only shares which items to look
// at, never bypasses the paywall.

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
  /** BB-082, corrected 2026-08-29: whether THIS collaborator can write into
   * the folder, not just read it -- a role on the person
   * (folder_collaborators.collab_mode), not a flag on the folder, so the
   * same account can be a viewer on one shared folder and an editor on
   * another. FolderPicker.tsx uses this to decide which of a user's
   * collaborations to even offer as an add target. */
  collabMode?: 'read_only' | 'read_write'
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
// Deliberately does NOT persist a freshly-generated token or mark the folder
// shared -- that only happens once the caller actually confirms the send
// completed, via confirmFolderShared below. A folder that's merely had a link
// minted (e.g. the owner tapped Invite, then backed out of the native share
// sheet before picking a recipient) must not show up in From Me -- see
// getMySharedFolders' share_token-is-not-null definition of "shared."
//
// Sharing is a per-folder Premium decision, not a whole-library one -- a user
// who has never turned on the separate, global "Back up & sync" toggle can
// still share a folder. On first share, this force-pushes exactly the rows a
// collaborator needs (the folder itself, its item pointers, and the content
// of any notes among those items -- notes aren't in a public reference table
// like ACs are, so their actual title/body has to reach the cloud too) past
// that toggle, ahead of confirmation, so the link is valid the instant it's
// actually sent. See folders.ts's Folder.shared and syncPush.ts's `force`
// param.
// Force-pushes a folder (and its own items/notes) to the cloud if it isn't
// there yet -- both share paths (link and Callsign) need the folder to exist
// in synced_folders before the server can act on it, but a folder created
// with the global "Back up & sync" toggle off only ever lives in local
// AsyncStorage. Without this, invite_folder_collaborator's ownership check
// (`user_id = auth.uid()`) simply finds no row and raises "Not authorized" --
// a confusing error for what's really just "this folder was never synced."
async function ensureFolderPushed(folderId: string): Promise<void> {
  const [folders, items, notes, bookmarks] = await Promise.all([
    getFolders(), getItemsInFolder(folderId), getNotes(), getBookmarks(),
  ])
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) throw new Error('Folder not found')

  await syncPushFolder(folder, true)
  // Excludes authorId-tagged items (a past collaborator's items already
  // pulled into this folder's local cache -- see FolderItem.authorId) and
  // seed notes (fake placeholder content every fresh install starts with --
  // see addExistingItemToSharedFolder's SEED_NOTE_NOT_SHAREABLE guard below,
  // which this bulk path never went through, real gap found 2026-08-16: a
  // seed note filed in a folder before it was ever shared got its pointer
  // force-pushed here regardless, silently handing a real collaborator a
  // dangling reference to a note whose content never leaves the device).
  const ownItems = items.filter((i) => !i.authorId && !(i.item_type === 'note' && isSeedNote(i.item_id)))
  if (ownItems.length) await syncPushFolderItems(ownItems, true)
  const noteMap = new Map(notes.map((n) => [n.id, n]))
  const noteItems = ownItems.filter((i) => i.item_type === 'note').map((i) => noteMap.get(i.item_id))
  await Promise.all(
    noteItems
      .filter((n): n is NonNullable<typeof n> => !!n && !n.authorId)
      .map((n) => syncPushNote(n, true))
  )
  // Same gap, same fix, for 'ac'-type items -- this covers BOTH plain AC
  // bookmarks and highlights (a highlight is just an 'ac' folder item whose
  // backing bookmark carries blockText/blockKind -- see addHighlight in
  // bookmarks.ts). Real gap found 2026-08-21: syncPushBookmark had no
  // `force` param at all until now, so a bookmark/highlight added while the
  // owner's personal Back-up & Sync toggle was off never reached
  // synced_bookmarks -- the folder item pointer force-pushed fine, but
  // resolveMissingAsHighlights below (which this exact scenario depends on)
  // found nothing to resolve, so the item silently vanished from every
  // collaborator's view. (A plain 'ac' bookmark item without matching
  // synced_bookmarks content still resolves fine via the public AC content
  // table directly -- only highlights, whose content lives ONLY in
  // synced_bookmarks, were actually broken by this; force-pushing both here
  // is simpler and correct either way.)
  const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
  const acItems = ownItems.filter((i) => i.item_type === 'ac').map((i) => bookmarkMap.get(i.item_id))
  await Promise.all(
    acItems
      .filter((b): b is BookmarkAC => !!b)
      .map((b) => syncPushBookmark(b, true))
  )
}

// Real data-loss bug found 2026-08-16 (RC, real device: shared a folder,
// added AC/FAR items right before sending, receiver got the notes but none
// of the regulations): this used to return the EXISTING share_token
// immediately, skipping ensureFolderPushed entirely, whenever the folder had
// already been shared once before. ensureFolderPushed only runs at
// getOrCreateShareLink-time, not continuously -- addManyToFolder/
// removeFromFolder (folders.ts) force-push new items past the personal
// Back-up & Sync toggle ONLY once folder.shared is true, which doesn't flip
// true until confirmFolderShared actually runs (see that function's own
// comment for why -- From Me visibility depends on it). Anything the owner
// added between tapping Invite and completing the native share sheet (or a
// SECOND invite of an already-shared folder, inviting person #2) landed in
// that exact gap: added while folder.shared was still false, then never
// re-synced because this early return meant ensureFolderPushed never ran
// again. Now runs on every call, not just the first -- cheap (a handful of
// idempotent upserts) and closes the gap for every invite path, not just
// first-share.
export async function getOrCreateShareLink(folderId: string): Promise<{ link: string; token: string }> {
  const { data: existing } = await supabase
    .from('synced_folders')
    .select('share_token')
    .eq('id', folderId)
    .maybeSingle()

  await ensureFolderPushed(folderId)

  if (existing?.share_token) return { link: buildShareLink(existing.share_token), token: existing.share_token }

  const token = makeShareToken()
  return { link: buildShareLink(token), token }
}

// Commits a link from getOrCreateShareLink once the caller has confirmed it
// was actually sent -- this is what makes the folder show up in From Me (see
// getMySharedFolders) and keeps future mutations force-pushing (see
// folders.ts's markFolderShared). Safe to call more than once with the same
// token (e.g. a folder that was already shared before this call) -- it's
// just re-setting the same value.
//
// Re-runs ensureFolderPushed one more time here too, not just from
// getOrCreateShareLink -- closes the remaining window between minting the
// link (getOrCreateShareLink) and the send actually completing (this call,
// which can be seconds to minutes later for the native-share-sheet path):
// anything added to the folder while that sheet was open is caught by this
// second pass instead of being silently stranded local-only forever.
export async function confirmFolderShared(folderId: string, token: string): Promise<void> {
  await ensureFolderPushed(folderId)
  await markFolderShared(folderId)
  const { error } = await supabase.from('synced_folders').update({ share_token: token }).eq('id', folderId)
  if (error) throw error
}

// The Callsign-invite counterpart to confirmFolderShared above. Same job
// (push this folder's content, mark it shared locally, make it visible in
// From Me) but it must NOT write the invite's own token into
// synced_folders.share_token, which is what submitCallsignInvite used to do
// by calling confirmFolderShared(folderId, invite.token) directly.
//
// Two real bugs came out of that aliasing, both found 2026-08-30 while
// tracing the four separate "invite by callsign does nothing" reports:
//
//  1. join_shared_folder checks folder_collaborators.invite_token FIRST and
//     only falls through to the anonymous share_token branch if no invite
//     row matches. So once share_token held a Callsign invite's token, the
//     folder's "Invite by Link" link (getOrCreateShareLink returns the
//     EXISTING share_token) resolved to that one person's invite row --
//     everyone else who tapped it got "This invite was sent to a different
//     FlyRegs account," and after the invitee accepted, "This invite has
//     already been accepted." A folder first shared by Callsign therefore
//     had a permanently broken link-invite path.
//  2. Each new Callsign invite overwrote share_token again, silently killing
//     any anonymous link the owner had already circulated.
//
// Minting an independent anonymous token here (only when the folder doesn't
// already have one) keeps From Me's share_token-is-not-null definition of
// "shared" working -- see getMySharedFolders -- without ever letting the two
// kinds of token be the same value.
export async function confirmFolderSharedByInvite(folderId: string): Promise<void> {
  await ensureFolderPushed(folderId)
  await markFolderShared(folderId)
  const { data: existing } = await supabase
    .from('synced_folders')
    .select('share_token')
    .eq('id', folderId)
    .maybeSingle()
  if (existing?.share_token) return
  const { error } = await supabase
    .from('synced_folders')
    .update({ share_token: makeShareToken() })
    .eq('id', folderId)
  if (error) throw error
}

// ── Pending (not-yet-accepted) Callsign invites ─────────────────────────────
// RC, four separate real-device reports across three testing sessions
// (2026-08-17; 2026-08-22 ea844156; 2026-08-29 e94a988c and 0d73eb1f), the
// last and most diagnostic being: "it says it actually found the Call sign
// ... I send the invite and it gives me a notification that the invite was
// sent ... BUT it doesn't seem like it actually sends anything. The other
// person never gets any kind of notification."
//
// Root cause, confirmed against the live DB rather than inferred: the invite
// itself was never the thing failing. folder_collaborators really does carry
// RC's 2026-08-29 04:12:07 invite to Adriana on folder mtduuv1moovst, with a
// valid invite_token -- still sitting there, accepted_at NULL, days later.
// What was missing is any way for the RECIPIENT to find out about it:
//
//   * The ONLY delivery channel was an Expo push (sendCollaborationInvitePush).
//     Adriana's account was ~13 minutes old at that moment and had no
//     push_tokens row at all, so get_collaboration_invite_push_target
//     returned zero rows and sendCollaborationInvitePush's own
//     `if (rows.length === 0) return` made it a silent no-op. The same
//     happens for anyone who declined the iOS notification prompt, or whose
//     push simply doesn't arrive.
//   * The invite is invisible in the app until it is accepted:
//     collaborators_view_shared_folders (see sync/migrations_fix_folder_
//     pending_invite_leak.sql) requires accepted_at IS NOT NULL, so
//     getMyCollaborations' synced_folders lookup returns nothing for a
//     pending row and Shared > With Me stays empty.
//   * Nothing anywhere else in the app listed pending invites -- grep for
//     accepted_at in src/ before this change: aircraftSharing.ts filters
//     them OUT, and no screen fetched them.
//
// So a Callsign invite whose push didn't land was unrecoverable: correct in
// the database, undiscoverable in the app, exactly "it doesn't seem like it
// actually sends anything." A push is a notification, not a delivery
// mechanism -- this makes the invite itself durable and self-serve.
//
// users_view_own_collaborations (auth.uid() = user_id) already lets the
// invitee read their own pending row including invite_token, so the list
// itself needs no migration. The folder NAME does -- collaborators_view_
// shared_folders deliberately hides an unaccepted folder -- so the label is
// best-effort via an optional RPC (sync/migrations_folder_pending_invite_
// inbox.sql) and degrades to a generic title if that migration hasn't been
// applied yet, rather than gating the whole feature on it.
export interface PendingFolderInvite {
  folderId: string
  /** The per-person invite token -- what join_shared_folder needs to accept.
   * Never the folder's anonymous share_token; see confirmFolderSharedByInvite. */
  token: string
  /** Null until sync/migrations_folder_pending_invite_inbox.sql is applied
   * (RLS hides an unaccepted folder's row) -- callers show a generic label. */
  folderName: string | null
  inviterLabel: string | null
  invitedAt: string
}

export async function getMyPendingFolderInvites(): Promise<PendingFolderInvite[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: rows } = await supabase
    .from('folder_collaborators')
    .select('folder_id, invite_token, joined_at')
    .eq('user_id', user.id)
    .is('left_at', null)
    .is('accepted_at', null)
    .not('invite_token', 'is', null)
  if (!rows?.length) return []

  // Best-effort enrichment, same shape (and same reason) as
  // getMyCollaborations' get_shared_folder_owners call: a missing name is a
  // cosmetic downgrade, never a reason to hide a real invite.
  const { data: meta } = await supabase
    .rpc('get_my_pending_folder_invites')
    .then((res) => res, () => ({ data: null as any[] | null }))
  const metaMap = new Map<string, { name: string | null; inviter: string | null }>(
    (meta ?? []).map((m: any) => [m.out_folder_id, { name: m.out_folder_name, inviter: m.out_inviter_label }])
  )

  return rows.map((r: any) => ({
    folderId: r.folder_id,
    token: r.invite_token as string,
    folderName: metaMap.get(r.folder_id)?.name ?? null,
    inviterLabel: metaMap.get(r.folder_id)?.inviter ?? null,
    invitedAt: r.joined_at,
  }))
}

// Turning down an invite without accepting it. Reuses the same self-leave
// path leaveSharedFolder uses -- guard_folder_collaborator_self_update
// (sync/migrations_fix_collaborator_self_escalation.sql) explicitly permits
// a collaborator to set their OWN left_at on the null -> non-null
// transition, and nothing else, so this needs no new policy or RPC. The
// owner still sees the row (soft, not deleted), same as someone leaving.
export async function declineFolderInvite(folderId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { error } = await supabase
    .from('folder_collaborators')
    .update({ left_at: new Date().toISOString() })
    .eq('folder_id', folderId)
    .eq('user_id', user.id)
    .is('accepted_at', null)
  if (error) throw error
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
  // RC (2026-08-29, live joint testing): per-collaborator mode changes
  // (owner toggling one person read_only <-> read_write) weren't
  // propagating, and a read_only collaborator's folder still showed up as
  // an addable target. Root cause: this function was reading
  // synced_folders.collab_mode below -- the folder-wide DEFAULT a brand-new
  // invite starts at (see setFolderCollabMode's own comment) -- instead of
  // THIS row's real, possibly-since-overridden collab_mode. BB-077
  // (migrations_per_invitee_collab_mode.sql) moved per-person access onto
  // folder_collaborators.collab_mode specifically so the owner's toggle for
  // one person wouldn't retroactively change anyone else, but this function
  // never got updated to read from there -- folder/shared/[id].tsx already
  // had and fixed the identical bug for its own screen (see its own
  // collaborator-mode read), this is the same fix applied here.
  const { data: memberships } = await supabase
    .from('folder_collaborators')
    .select('folder_id, last_viewed_at, collab_mode')
    .eq('user_id', user.id)
    .is('left_at', null)
  const folderIds = (memberships ?? []).map((m) => m.folder_id)
  if (!folderIds.length) return []
  const unreadMap = new Map((memberships ?? []).map((m) => [m.folder_id, m.last_viewed_at == null]))
  const collabModeMap = new Map((memberships ?? []).map((m) => [m.folder_id, (m as any).collab_mode as FolderCollabMode | null]))

  // Exclude folders the owner has since (soft-)deleted -- deleteFolder() only
  // flips a `deleted` flag rather than removing the row, so without this
  // filter a collaborator would keep seeing a folder the owner thinks is gone.
  const { data: folders } = await supabase
    .from('synced_folders')
    .select('id, name')
    .in('id', folderIds)
    .eq('deleted', false) as { data: { id: string; name: string }[] | null }
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
    collabMode: collabModeMap.get(f.id) ?? 'read_only',
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
  /** The synced_folder_items row's own id -- distinct from item_id (the AC's
   * id). Needed by removeSharedFolderItem, which targets this row, not the
   * content it points at. */
  id: string
  item_id: string
}

export async function getSharedFolderACItems(folderId: string): Promise<SharedFolderACItem[]> {
  const { data } = await supabase
    .from('synced_folder_items')
    .select('id, item_id')
    .eq('folder_id', folderId)
    .eq('item_type', 'ac')
    .eq('deleted', false)
  return data ?? []
}

// Generic FAR/AIM/P-CG/AD/LOI item-pointer fetch -- mirrors
// getSharedFolderACItems exactly (RLS on synced_folder_items is scoped by
// folder_id only, never item_type, so a collaborator could always read
// these rows; the shared-folder screen just never fetched anything but
// 'ac' and 'note'). Confirmed live via the #154 process-flow audit: a
// FAR/AIM/AD/PCG/LOI item added to a shared folder synced to the cloud
// correctly but was completely invisible to collaborators.
async function getSharedFolderItemsByType(folderId: string, itemType: string): Promise<{ id: string; item_id: string }[]> {
  const { data } = await supabase
    .from('synced_folder_items')
    .select('id, item_id')
    .eq('folder_id', folderId)
    .eq('item_type', itemType)
    .eq('deleted', false)
  return data ?? []
}

export const getSharedFolderFARItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'far')
export const getSharedFolderAIMItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'aim')
export const getSharedFolderPCGItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'pcg')
export const getSharedFolderADItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'ad')
export const getSharedFolderLOIItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'loi')
// 49 CFR (NTSB 830/TSA 1544+1552/HMR 175) shipped as a folderable type after
// the #154/dictionary fix above, and would have silently reintroduced the
// exact same gap if this file weren't touched: synced_folder_items' CHECK
// constraint and RLS already cover 'cfr49' (verified live), but nothing here
// fetched it -- confirmed via a fresh B32-readiness audit before this content
// type had any real usage to expose the gap in production.
export const getSharedFolderCfr49Items = (folderId: string) => getSharedFolderItemsByType(folderId, 'cfr49')
// Aviation Dictionary terms (incl. mnemonics) shipped as a folderable type
// AFTER the #154 fix above, and reintroduced the exact bug that comment
// describes: synced_folder_items' CHECK constraint accepts 'dictionary'
// (verified live -- there are already real dictionary rows in the table),
// RLS lets a collaborator read them, but folder/shared/[id].tsx fetched
// every type EXCEPT this one, so a shared folder's dictionary entries were
// invisible to everyone but the owner.
export const getSharedFolderDictionaryItems = (folderId: string) => getSharedFolderItemsByType(folderId, 'dictionary')

export interface SharedFolderNoteItem {
  id: string
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
    .select('id, item_id')
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
// left_at is a SOFT leave, and the RLS policies now check it -- a departed
// collaborator loses read access to the folder and its items (they didn't
// before; leaving revoked nothing). The user_id filter is explicit rather
// than leaning on the UPDATE policy to scope the statement: without it this
// reads as "stamp left_at on every collaborator of this folder", which is
// one policy change away from being true.
export async function leaveSharedFolder(folderId: string): Promise<void> {
  const { data } = await supabase.auth.getUser()
  const userId = data.user?.id
  if (!userId) return
  await supabase
    .from('folder_collaborators')
    .update({ left_at: new Date().toISOString() })
    .eq('folder_id', folderId)
    .eq('user_id', userId)
}

export type FolderCollabMode = 'read_only' | 'read_write'

export interface FolderCollaborator {
  userId: string
  /** The collaborator's chosen callsign (Account > Callsign), falling back
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
  /** BB-077: per-invitee, not per-folder -- see setCollaboratorMode below. */
  collabMode: FolderCollabMode
  /** False until this specific person has actually opened a NAMED
   * (Callsign) invite link and accepted it -- the roster row for a pending
   * invite shows greyed out with an "Invited" badge instead of a real
   * access badge. Always true for anyone who joined via the folder's
   * anonymous link (the "Invite" header icon), which has no such pending
   * state -- see inviteCollaboratorByCallsign below. */
  accepted: boolean
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
    collabMode: (row.out_collab_mode as FolderCollabMode) ?? 'read_only',
    accepted: !!row.out_accepted,
  }))
}

// RC: "since the receiver has to have a FR account to get the shared
// folders... it's not bad to suggest there too (like with a/c sharing) that
// they create a Callsign... scope it a build it. should be fairly
// straightforward since you already built it in the a/c area." Mirrors
// aircraftSharing.ts's inviteCollaboratorByCallsign exactly, minus the role
// param -- a folder's per-invitee access (BB-077's collabMode) already has
// its own default+override mechanism (the "NEW INVITES GET" toggle plus
// setCollaboratorMode after they join), so this doesn't need a second
// role-picker step the way aircraft's viewer/editor invite does.
export interface FolderCallsignInvite {
  token: string
  userId: string
  callsign: string
}

export async function inviteCollaboratorByCallsign(folderId: string, callsign: string): Promise<FolderCallsignInvite> {
  await ensureFolderPushed(folderId)

  const token = makeShareToken()
  const { data, error } = await supabase.rpc('invite_folder_collaborator', {
    p_folder_id: folderId,
    p_callsign: callsign,
    p_token: token,
  })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('Could not create invite')
  return { token: row.out_token, userId: row.out_user_id, callsign: row.out_callsign }
}

// aircraftSharing.ts's removeCollaborator already had to solve this exact
// problem (see its own comment) -- found missing here in the 2026-08-29
// "built but inert" sweep: removing someone who joined via the open share
// link (no invite_token -- a targeted Callsign invite has one, an anonymous
// link-join doesn't) left the link itself untouched, so "Remove Access"
// didn't actually remove access -- they could tap the same link again and
// rejoin instantly with the same role. Only retiring the link when the
// removed person actually came in through it (not on every removal) avoids
// invalidating a link the owner is still actively circulating to others;
// getOrCreateShareLink mints a fresh token on the next Share tap regardless,
// so nothing is lost permanently.
export async function removeCollaborator(folderId: string, userId: string): Promise<void> {
  const { data: row } = await supabase
    .from('folder_collaborators')
    .select('invite_token')
    .eq('folder_id', folderId)
    .eq('user_id', userId)
    .maybeSingle()

  const { error } = await supabase
    .from('folder_collaborators')
    .delete()
    .eq('folder_id', folderId)
    .eq('user_id', userId)
  if (error) throw error

  if (row && !row.invite_token) {
    const { error: linkErr } = await supabase
      .from('synced_folders')
      .update({ share_token: null })
      .eq('id', folderId)
    // Best-effort: access is already revoked above, this only closes the
    // re-entry path. Loud rather than silent so a failure is diagnosable.
    if (linkErr) console.error('Failed to retire the folder share link after a removal:', linkErr.message)
  }
}

// BB-077: each collaborator gets their own read/write mode -- the same
// folder can have one editor and one viewer at once. Owner-only in
// practice via RLS's owners_update_collaborator_mode policy.
export async function setCollaboratorMode(folderId: string, userId: string, mode: FolderCollabMode): Promise<void> {
  const { error } = await supabase
    .from('folder_collaborators')
    .update({ collab_mode: mode })
    .eq('folder_id', folderId)
    .eq('user_id', userId)
  if (error) throw error
}

// This is now only the DEFAULT a NEW collaborator starts at when they join
// (see join_shared_folder) -- it no longer retroactively changes anyone
// already on the folder, which is what setCollaboratorMode above is for.
// Owner-only in practice: RLS's users_manage_own_synced_folders already
// restricts the underlying UPDATE to auth.uid() = user_id, this just gives
// it a name.
export async function setFolderCollabMode(folderId: string, mode: FolderCollabMode): Promise<void> {
  const { error } = await supabase.from('synced_folders').update({ collab_mode: mode }).eq('id', folderId)
  if (error) throw error
}

export async function getFolderCollabMode(folderId: string): Promise<FolderCollabMode> {
  const { data } = await supabase.from('synced_folders').select('collab_mode').eq('id', folderId).maybeSingle()
  return (data?.collab_mode as FolderCollabMode) ?? 'read_only'
}

// ── Direct cross-account writes ─────────────────────────────────────────────
// Everything below writes straight to Supabase with no local-storage
// involvement, unlike the owner-side helpers in folders.ts. Two distinct
// reasons converge on the same shape:
//
//  1. The collaborator's shared/[id].tsx screen never had a local mirror of
//     someone else's folder to begin with -- it has always been a pure
//     remote read (see getSharedFolderACItems etc. above), so a
//     collaborator's own writes have nowhere local to go through either.
//  2. Editing a row this account doesn't own (an owner editing a
//     collaborator's note, or an editor-collaborator editing someone else's
//     item) can't go through the normal syncPush* upsert path -- those all
//     upsert onConflict (user_id, id) under the CALLING account's own
//     user_id, which would create a duplicate row rather than update the
//     original when the row's real user_id differs. A plain update-by-id
//     has no such conflict key to get wrong; RLS alone decides whether it's
//     allowed (owners_manage_own_/editors_manage_shared_folder_items,
//     owners_manage_shared_notes/editors_manage_shared_notes).

export async function removeSharedFolderItem(itemRowId: string): Promise<void> {
  const { error } = await supabase
    .from('synced_folder_items')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('id', itemRowId)
  if (error) throw error
}

// BB-082: lets a read_write collaborator add an EXISTING item (an AC/FAR/
// AIM/PCG/AD/LOI/dictionary bookmark, or one of their own already-written
// notes) into a folder they don't own, from the app-wide FolderPicker --
// previously the only cross-account write here was addSharedFolderNote,
// which creates a brand-new note, not "file this existing thing into
// someone else's folder." Server-side this was already fully supported and
// unused: editors_manage_shared_folder_items' RLS policy (has_folder_access
// with p_require_editor=true) already permits exactly this insert, gated on
// the folder's own collab_mode -- no new RPC or migration needed, just the
// client-side call nothing was making.
//
// Inserted under the CALLER's own user_id (an insert, not an update, so the
// normal RLS insert path applies) -- mirrors addSharedFolderNote's item
// pointer exactly. Silently no-ops if already present (same idempotent
// shape as addManyToFolder's own dedupe), so a caller doesn't need to
// pre-check membership itself.
// Thrown by addExistingItemToSharedFolder when asked to share one of the
// fake demo notes every fresh install starts with (id prefix "seed-", see
// lib/notes.ts's isSeedNote) -- caught live in testing: without this guard,
// the note got force-pushed to synced_notes and a folder_item pointer was
// created, silently handing a collaborator fake placeholder content under
// a real cloud row. Seed notes are supposed to never leave the device (see
// sync.ts's own isSeedNote checks) -- this is the one path that didn't
// check yet.
export const SEED_NOTE_NOT_SHAREABLE = 'SEED_NOTE_NOT_SHAREABLE'

export async function addExistingItemToSharedFolder(folderId: string, itemType: FolderItemType, itemId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  if (itemType === 'note' && isSeedNote(itemId)) throw new Error(SEED_NOTE_NOT_SHAREABLE)

  // A note this account has never pushed to the cloud (Back-up & Sync off,
  // or on but this note predates it) has no synced_notes row for the
  // folder owner to read via owners_manage_shared_notes/editors_manage_
  // shared_notes -- force-push it now regardless of that toggle, same as
  // getOrCreateShareLink already does for the OWNER's own shared-folder
  // notes. Without this, the folder_item pointer would insert cleanly but
  // resolve to nothing on the owner's side.
  if (itemType === 'note') {
    const notes = await getNotes()
    const note = notes.find((n) => n.id === itemId)
    if (note) await syncPushNote(note, true)
  }

  // Exactly the same gap for every NON-note type -- found and PROVEN live,
  // 2026-08-29/30, from three independent pieces of real evidence rather
  // than inspection:
  //   1. RC (real device, feedback 16558ccd, 2026-08-29 04:35 UTC): "I tried
  //      to add a shared highlighted document ... to a folder that somebody
  //      shared with me, but it never made it into that folder."
  //   2. synced_folder_items really does carry his rows for it -- two of
  //      them, folder mrsfnty7ya5sj, item_id
  //      46e2399d-...-hl-1787977820654-r62kqe, added 04:31:19 and 04:33:20
  //      (he retried, because nothing appeared). The POINTER insert always
  //      worked; that was never the failure.
  //   3. synced_bookmarks has ZERO rows for his account. His personal
  //      "Back up & sync" toggle is off, so syncPushBookmark's non-force
  //      path (currentUserId's `!force && !isSyncEnabled()` check in
  //      syncPush.ts) has never pushed a single bookmark of his.
  // A highlight's content (ac_id + block_text/block_label/block_snippet)
  // exists ONLY in synced_bookmarks -- see resolveMissingAsHighlights, which
  // is the sole way any shared-folder screen can render one. With no row
  // there, the pointer resolves to nothing and the item is invisible to
  // EVERYONE, including the person who just added it. Plain (non-highlight)
  // bookmarks were unaffected, which is exactly why this reads as a
  // type-specific silent failure rather than "sharing is broken."
  //
  // ensureFolderPushed above already does precisely this for the OWNER's own
  // folder at invite time (see its 2026-08-21 'ac'-type comment) -- this is
  // the same fix for the cross-account write path, which never got it.
  // Force, not a plain push, for the same reason: the adder's own global
  // Back-up & Sync toggle is irrelevant to whether a folder they're actively
  // sharing into needs this row.
  if (itemType !== 'note') {
    const bookmarks = await getBookmarks()
    const bm = bookmarks.find((b) => b.id === itemId)
    if (bm) await syncPushBookmark(bm, true)
  }

  // The DB itself is the dedupe now (idx_synced_folder_items_unique_active,
  // a partial unique index on (folder_id, item_type, item_id) WHERE deleted
  // = false) -- a prior SELECT-then-INSERT here was a real TOCTOU race
  // (confirmed live, 2026-08-29: a rapid double-tap/retry could create
  // multiple active rows for the same item, each with its own fresh
  // makeItemId(), since nothing tied them together). A real unique-
  // violation (23505) here means someone else's concurrent call already
  // won -- exactly the "silently no-op if already present" behavior this
  // function has always promised, just enforced atomically instead of
  // racily.
  const now = new Date().toISOString()
  const { error } = await supabase.from('synced_folder_items').insert({
    id: makeItemId(), user_id: user.id, folder_id: folderId, item_type: itemType, item_id: itemId,
    added_at: now, updated_at: now, deleted: false,
  })
  if (error && error.code !== '23505') throw error
}

// The remove counterpart -- unlike removeSharedFolderItem (which targets a
// known synced_folder_items row id), FolderPicker only ever knows the
// (folder, type, item) triple, same as its own local removeFromFolder.
export async function removeExistingItemFromSharedFolder(folderId: string, itemType: FolderItemType, itemId: string): Promise<void> {
  const { error } = await supabase
    .from('synced_folder_items')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('folder_id', folderId).eq('item_type', itemType).eq('item_id', itemId).eq('deleted', false)
  if (error) throw error
}

// Which of the given foreign folders already contain this item -- lets
// FolderPicker seed its membership checkmarks for shared folders the same
// way getFoldersForItem does for the user's own local ones.
export async function getSharedFolderMembership(folderIds: string[], itemType: FolderItemType, itemId: string): Promise<Set<string>> {
  if (!folderIds.length) return new Set()
  const { data } = await supabase
    .from('synced_folder_items')
    .select('folder_id')
    .in('folder_id', folderIds).eq('item_type', itemType).eq('item_id', itemId).eq('deleted', false)
  return new Set((data ?? []).map((r) => r.folder_id))
}

// Adds a brand-new note directly into a shared folder -- always inserted
// under the CALLER's own user_id (an insert, unlike the update helpers
// above, so the normal RLS insert path applies: users_manage_own_synced_
// notes for the note itself, editors_manage_shared_folder_items for the
// pointer). Two inserts, not one -- mirrors addManyToFolder's own note-
// linking shape in folders.ts exactly, just without any local-storage step.
export async function addSharedFolderNote(folderId: string, title: string, body: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const noteId = `note-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const now = new Date().toISOString()
  const { error: noteError } = await supabase.from('synced_notes').insert({
    id: noteId, user_id: user.id, title, body, linked_ac: null, updated_at: now, deleted: false,
  })
  if (noteError) throw noteError
  const itemId = `item-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const { error: itemError } = await supabase.from('synced_folder_items').insert({
    id: itemId, user_id: user.id, folder_id: folderId, item_type: 'note', item_id: noteId,
    added_at: now, updated_at: now, deleted: false,
  })
  if (itemError) throw itemError
}

// Thrown by updateSharedNote specifically when RLS silently dropped the
// write -- see that function's own comment for why this needs its own
// error class rather than a generic throw.
export class SharedNoteAccessLostError extends Error {
  constructor() {
    super('You no longer have edit access to this note.')
    this.name = 'SharedNoteAccessLostError'
  }
}

// Plain update-by-id -- see the section comment above for why this can't be
// the normal syncPushNote upsert. Used for editing a note in a shared
// folder regardless of who authored it (the owner editing a collaborator's
// note, an editor-collaborator editing anyone's), and reused by notes.tsx
// for the owner's own local Notes tab when the open note is authorId-tagged.
//
// Selects the row back and checks it actually came back, rather than just
// checking `error` -- confirmed live (post-build-31 sweep) that PostgREST
// returns a clean 2xx with zero rows affected when RLS's WHERE-clause
// filter matches nothing, which is exactly what happens when an owner
// downgrades a collaborator's collab_mode to read_only while that
// collaborator still has an edit open: `editors_manage_shared_notes`
// re-checks collab_mode live on every query, so the very next save from
// that already-open screen silently writes nothing. The caller was reading
// that as success (no `error`), updating its own local state, and telling
// the user the edit was saved when it never reached the database.
export async function updateSharedNote(noteId: string, updates: { title?: string; body?: string }): Promise<void> {
  const { data, error } = await supabase
    .from('synced_notes')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new SharedNoteAccessLostError()
}

// Resolves collaborator-authored (FolderItem.authorId-tagged) non-note items
// into the same BookmarkAC shape the owner's own bookmarks use, so
// folder/[id].tsx can render them through its existing SwipeableACRow with
// no special-cased UI -- a collaborator's FAR addition should look exactly
// like the owner's own would. These were never in the owner's OWN
// bookmarks (expected, not a gap -- the collaborator never touched the
// owner's personal bookmark list), so they can't resolve through the normal
// bookmarkMap path; each type is looked up directly against its own content
// table instead, the same per-type queries folder/shared/[id].tsx's
// read-only collaborator view already runs.
// A highlight's folder item stores the highlight bookmark's own synthetic id
// as item_id, not the real document id (see BookmarkAC.id's comment in
// bookmarks.ts), so it never matches a row in that type's own content table
// above -- it silently vanished from every collaborator's view. Corrected
// 2026-08-21: this comment used to claim every highlight is pushed to
// synced_bookmarks "unconditionally... unlike normal bookmarks" the moment
// it's created -- that was never actually true (syncPushBookmark had no
// `force` param and addHighlight never bypassed the personal Back-up & Sync
// toggle any differently than a plain bookmark does), which meant this
// entire fallback silently found nothing for any owner with that toggle
// off. Real fix is at share time, not creation time: ensureFolderPushed
// above now force-pushes the backing synced_bookmarks row for every 'ac'-
// type item (bookmark or highlight alike) the same way it already did for
// notes, so any item_id the direct lookup above missed gets a second pass
// here: resolve it as a highlight via synced_bookmarks (ac_id + block_text
// carry the real doc + passage), then look up that doc's own current title
// the same way the direct path does. Requires the
// collaborators_read_shared_bookmarks RLS policy -- see
// sync/migrations_shared_folder_highlights.sql.
export async function resolveMissingAsHighlights(itemType: FolderItemType, missedIds: string[], savedAtFor: (id: string) => string): Promise<BookmarkAC[]> {
  if (!missedIds.length) return []
  // synced_bookmarks_gated, not the raw table -- same reasoning as
  // sync.ts's mergeBookmarks (see sync/migrations_fix_synced_bookmarks_
  // highlight_gate_leak.sql). A no-op in practice for a real collaborator
  // here specifically (has_folder_access()'s RLS already requires them to
  // currently hold Premium, which implies every other tier's access too),
  // but the raw table shouldn't be read for gated body text from a second
  // place that has to independently stay correct if that RLS ever changes.
  const { data: hlRows } = await supabase
    .from('synced_bookmarks_gated')
    .select('id, ac_id, block_kind, block_label, block_snippet, block_text')
    .eq('item_type', itemType)
    .in('id', missedIds)
  if (!hlRows?.length) return []

  const docIds = [...new Set(hlRows.map((h) => h.ac_id).filter((v): v is string => !!v))]
  if (!docIds.length) return []

  type DocRow = { id: string; document_number: string; title: string; date_issued?: string | null; office?: string | null; subject_series?: string | null }
  let docs: DocRow[] = []
  if (itemType === 'ac') {
    const { data } = await supabase.from('advisory_circulars').select('id, document_number, title, date_issued, office, subject_series').in('id', docIds)
    docs = data ?? []
  } else if (itemType === 'far') {
    const { data } = await supabase.from('far_sections').select('section_number, title').in('section_number', docIds)
    docs = (data ?? []).map((r) => ({ id: r.section_number, document_number: r.section_number, title: r.title }))
  } else if (itemType === 'aim') {
    const { data } = await supabase.from('aim_paragraphs').select('paragraph_number, title').in('paragraph_number', docIds)
    docs = (data ?? []).map((r) => ({ id: r.paragraph_number, document_number: r.paragraph_number, title: r.title ?? '' }))
  } else if (itemType === 'pcg') {
    const { data } = await supabase.from('pcg_terms').select('slug, term').in('slug', docIds)
    docs = (data ?? []).map((r) => ({ id: r.slug, document_number: r.term, title: r.term }))
  } else if (itemType === 'ad') {
    const { data } = await supabase.from('airworthiness_directives').select('ad_number, subject_heading').in('ad_number', docIds)
    docs = (data ?? []).map((r) => ({ id: r.ad_number, document_number: r.ad_number, title: r.subject_heading }))
  } else if (itemType === 'loi') {
    const { data } = await supabase.from('legal_interpretations').select('slug, title').in('slug', docIds)
    docs = (data ?? []).map((r) => ({ id: r.slug, document_number: r.slug, title: r.title }))
  } else if (itemType === 'cfr49') {
    const { data } = await supabase.from('cfr49_sections').select('section_number, title').in('section_number', docIds)
    docs = (data ?? []).map((r) => ({ id: r.section_number, document_number: r.section_number, title: r.title }))
  }
  const docMap = new Map(docs.map((d) => [d.id, d]))

  const results: BookmarkAC[] = []
  for (const h of hlRows) {
    if (!h.ac_id) continue
    const doc = docMap.get(h.ac_id)
    if (!doc) continue
    results.push({
      id: h.id,
      itemType,
      acId: h.ac_id,
      document_number: doc.document_number,
      title: doc.title,
      date_issued: doc.date_issued ?? null,
      office: doc.office ?? null,
      subject_series: doc.subject_series ?? null,
      blockKind: (h.block_kind as 'section' | 'item' | 'para' | null) ?? undefined,
      blockLabel: h.block_label ?? undefined,
      blockSnippet: h.block_snippet ?? undefined,
      blockText: h.block_text ?? undefined,
      savedAt: savedAtFor(h.id),
    })
  }
  return results
}

export async function resolveForeignFolderEntries(items: FolderItem[]): Promise<BookmarkAC[]> {
  const byType = new Map<string, FolderItem[]>()
  for (const i of items) {
    if (i.item_type === 'note') continue
    if (!byType.has(i.item_type)) byType.set(i.item_type, [])
    byType.get(i.item_type)!.push(i)
  }
  if (!byType.size) return []

  const results: BookmarkAC[] = []
  const savedAtFor = (list: FolderItem[], itemId: string) => list.find((i) => i.item_id === itemId)?.added_at ?? new Date().toISOString()

  const acItems = byType.get('ac') ?? []
  if (acItems.length) {
    const acIds = acItems.map((i) => i.item_id)
    const { data } = await supabase
      .from('advisory_circulars')
      .select('id, document_number, title, date_issued, office, subject_series')
      .in('id', acIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.id)
      results.push({
        id: r.id, itemType: 'ac', document_number: r.document_number, title: r.title,
        date_issued: r.date_issued, office: r.office, subject_series: r.subject_series,
        savedAt: savedAtFor(acItems, r.id),
      })
    }
    results.push(...await resolveMissingAsHighlights('ac', acIds.filter((id) => !matched.has(id)), (id) => savedAtFor(acItems, id)))
  }

  const farItems = byType.get('far') ?? []
  if (farItems.length) {
    const farIds = farItems.map((i) => i.item_id)
    const { data } = await supabase.from('far_sections').select('section_number, title').in('section_number', farIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.section_number)
      results.push({ id: r.section_number, itemType: 'far', document_number: r.section_number, title: r.title, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(farItems, r.section_number) })
    }
    results.push(...await resolveMissingAsHighlights('far', farIds.filter((id) => !matched.has(id)), (id) => savedAtFor(farItems, id)))
  }

  const aimItems = byType.get('aim') ?? []
  if (aimItems.length) {
    const aimIds = aimItems.map((i) => i.item_id)
    const { data } = await supabase.from('aim_paragraphs').select('paragraph_number, title').in('paragraph_number', aimIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.paragraph_number)
      results.push({ id: r.paragraph_number, itemType: 'aim', document_number: r.paragraph_number, title: r.title ?? '', date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(aimItems, r.paragraph_number) })
    }
    results.push(...await resolveMissingAsHighlights('aim', aimIds.filter((id) => !matched.has(id)), (id) => savedAtFor(aimItems, id)))
  }

  const pcgItems = byType.get('pcg') ?? []
  if (pcgItems.length) {
    const pcgIds = pcgItems.map((i) => i.item_id)
    const { data } = await supabase.from('pcg_terms').select('slug, term').in('slug', pcgIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.slug)
      results.push({ id: r.slug, itemType: 'pcg', document_number: r.term, title: r.term, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(pcgItems, r.slug) })
    }
    results.push(...await resolveMissingAsHighlights('pcg', pcgIds.filter((id) => !matched.has(id)), (id) => savedAtFor(pcgItems, id)))
  }

  const adItems = byType.get('ad') ?? []
  if (adItems.length) {
    const adIds = adItems.map((i) => i.item_id)
    const { data } = await supabase.from('airworthiness_directives').select('ad_number, subject_heading').in('ad_number', adIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.ad_number)
      results.push({ id: r.ad_number, itemType: 'ad', document_number: r.ad_number, title: r.subject_heading, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(adItems, r.ad_number) })
    }
    results.push(...await resolveMissingAsHighlights('ad', adIds.filter((id) => !matched.has(id)), (id) => savedAtFor(adItems, id)))
  }

  const loiItems = byType.get('loi') ?? []
  if (loiItems.length) {
    const loiIds = loiItems.map((i) => i.item_id)
    const { data } = await supabase.from('legal_interpretations').select('slug, title').in('slug', loiIds)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.slug)
      results.push({ id: r.slug, itemType: 'loi', document_number: r.slug, title: r.title, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(loiItems, r.slug) })
    }
    results.push(...await resolveMissingAsHighlights('loi', loiIds.filter((id) => !matched.has(id)), (id) => savedAtFor(loiItems, id)))
  }

  const cfr49Items = byType.get('cfr49') ?? []
  if (cfr49Items.length) {
    const cfr49Ids = cfr49Items.map((i) => i.item_id)
    const { data } = await supabase.from('cfr49_sections').select('section_number, title').in('section_number', cfr49Ids)
    const matched = new Set<string>()
    for (const r of data ?? []) {
      matched.add(r.section_number)
      results.push({ id: r.section_number, itemType: 'cfr49', document_number: r.section_number, title: r.title, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(cfr49Items, r.section_number) })
    }
    results.push(...await resolveMissingAsHighlights('cfr49', cfr49Ids.filter((id) => !matched.has(id)), (id) => savedAtFor(cfr49Items, id)))
  }

  const dictItems = byType.get('dictionary') ?? []
  if (dictItems.length) {
    const { data } = await supabase.from('dictionary_terms').select('slug, term').in('slug', dictItems.map((i) => i.item_id))
    for (const r of data ?? []) {
      results.push({ id: r.slug, itemType: 'dictionary', document_number: r.term, title: r.term, date_issued: null, office: null, subject_series: null, savedAt: savedAtFor(dictItems, r.slug) })
    }
  }

  return results
}

// Note-type counterpart to resolveForeignFolderEntries above, used the same
// way and for the same reason: folder/[id].tsx's own loadLocal() calls this
// for ANY note item -- a collaborator's, or this SAME account's own note
// added from a second device -- that's missing from THIS device's local
// note cache, before concluding it's genuinely gone. 2026-08-21 fix: a note
// item this account authored itself used to get treated as orphaned (and
// permanently self-heal-deleted, locally AND on the server) the moment it
// wasn't in the local note cache yet, with no chance to actually resolve --
// syncFolderFromCloud (which DOES pull any note in this folder, regardless
// of author) only runs AFTER loadLocal in folder/[id].tsx's own load(), so a
// note pulled in by realtime/syncFolderFromCloud's OWN folder-item merge one
// tick before its content synced down read as "doesn't exist." Only an item
// that ALSO fails to resolve here is safe to self-heal.
export async function resolveForeignNoteEntries(items: FolderItem[]): Promise<Note[]> {
  const noteIds = items.filter((i) => i.item_type === 'note').map((i) => i.item_id)
  if (!noteIds.length) return []
  const { data: { user } } = await supabase.auth.getUser()
  const myId = user?.id
  const { data } = await supabase
    .from('synced_notes')
    .select('id, title, body, linked_ac, updated_at, user_id')
    .in('id', noteIds)
    .eq('deleted', false)
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    linked_ac: r.linked_ac,
    updated_at: r.updated_at,
    // See Note.authorId -- lets folder/[id].tsx's handleSaveNote route a
    // later edit through updateSharedNote instead of syncPushNote the same
    // way an already-locally-cached foreign note does.
    ...(myId && r.user_id !== myId ? { authorId: r.user_id } : {}),
  }))
}

// Everything above this line is pull-on-focus only (`useFocusEffect`) --
// this hook is the one live-push mechanism in the app. It doesn't fetch
// anything itself; it just re-fires `onChange` (the screen's own existing
// `load()`) whenever a row this account is RLS-authorized to see changes
// in one of the three tables that make up a shared folder. That's enough
// for both the owner's `folder/[id].tsx` and the collaborator's
// `folder/shared/[id].tsx` to see each other's edits without needing to
// background/refocus the screen first -- closing the exact gap
// [[gotcha_bb086_089_shared_sync_verified]] documented as still real and
// unbuilt. `synced_notes` has no folder_id column, so it's subscribed
// unfiltered -- Realtime still authorizes each event against this
// client's own RLS policies, so a note this account can't see never
// arrives; it just means a completely unrelated note edit can trigger one
// extra (harmless, idempotent) reload of an open folder screen. Debounced
// so a burst of changes (e.g. adding 5 items) triggers one reload, not 5.
// The user-scoped counterpart to useFolderRealtime below: fires onChange
// whenever ANY of this account's own folder_collaborators rows change,
// rather than one folder's.
//
// RC (2026-08-29, feedback 685c98e4): "if they change that permission
// setting back-and-forth, then that folder will need to appear disappear and
// reappear in your list of folder selections each time they make that
// change." FolderPicker already re-reads getMyCollaborations() every time it
// opens, so a mode flip is picked up on the NEXT open -- but a picker that
// is already on screen when the owner flips the toggle kept offering a
// folder the user can no longer write to (or kept hiding one they now can),
// with the tap failing server-side on editors_manage_shared_folder_items.
//
// Filtered to user_id=eq.<me>, which is also exactly what
// users_view_own_collaborations authorizes, so this can never deliver
// another collaborator's access change. `enabled` gates the subscription so
// the many mounted-but-invisible FolderPickers across the app don't each
// hold an open channel. Per-mount-unique topic name for the same
// channel-reuse race documented on useFolderRealtime below.
export function useMyCollaborationsRealtime(enabled: boolean, userId: string | undefined, onChange: () => void): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!enabled || !userId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onChangeRef.current(), 400)
    }
    const channel = supabase
      .channel(`my-collabs-${userId}-${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'folder_collaborators', filter: `user_id=eq.${userId}` }, debounced)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [enabled, userId])
}

export function useFolderRealtime(folderId: string | undefined, onChange: () => void): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!folderId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onChangeRef.current(), 400)
    }
    // Real crash, RC real-device report 2026-08-22 (Sentry: "cannot add
    // postgres_changes callbacks for realtime:folder-realtime-<id> after
    // `subscribe()`", immediately followed by a WatchdogTermination RAM
    // kill in the same session): supabase-js's own client.channel(topic)
    // (RealtimeClient.js) reuses an EXISTING channel object if one with the
    // same topic string is still registered, rather than always creating a
    // fresh one -- confirmed directly against
    // node_modules/@supabase/realtime-js/dist/module/RealtimeClient.js.
    // removeChannel() below (this effect's own cleanup) isn't synchronous,
    // so a rapid unmount+remount of this screen for the SAME folder (RC
    // navigating away and back in quickly -- this codebase has already
    // documented this exact "many movements and clicks happen quickly"
    // pattern biting other screens) could re-run this effect before the
    // previous instance's channel had actually finished being removed from
    // the client's registry. The new effect then got back that STALE,
    // already-subscribed channel object, and calling .on() on it again
    // (after its own earlier .subscribe() had already resolved) is exactly
    // what throws this error -- and an orphaned, still-registered channel
    // per abandoned attempt is a real leaked-resource shape consistent with
    // the RAM buildup a watchdog kill implies. A per-mount-unique topic
    // name sidesteps the whole race: it can never collide with a
    // not-yet-fully-removed channel from a previous mount, regardless of
    // how fast cleanup does or doesn't finish. The actual postgres_changes
    // filters below (table/event/folder_id) are what determine delivery,
    // not the topic string, so uniqueness here has no functional cost.
    const channel = supabase
      .channel(`folder-realtime-${folderId}-${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'synced_folder_items', filter: `folder_id=eq.${folderId}` }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'synced_notes' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'synced_folders', filter: `id=eq.${folderId}` }, debounced)
      // RC: a collaborator's r/w access change (owner flips Viewer <->
      // Editor) needs to land immediately, not just on next focus/
      // foreground -- folder/shared/[id].tsx's load() already re-reads its
      // own folder_collaborators row correctly, it just never got told to.
      // users_view_own_collaborations RLS scopes delivery to a
      // collaborator's own row, so this can't leak another collaborator's
      // access change to someone who shouldn't see it.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'folder_collaborators', filter: `folder_id=eq.${folderId}` }, debounced)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [folderId])
}
