import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'

// Fleet aircraft sharing -- viewer/editor collaborators. Mirrors
// sharedFolders.ts's shape closely, but folders are read-only by design,
// so this adds the role concept folders never needed (RC: "you'll need to
// build in the 'editor' side of the perms").
//
// RC, after seeing the manual-code v1: "why do we need that. an invite
// should be sent via a text link to join (just like folder). receiver
// taps text icon, CTA pops up, they click Join and that a/c is
// automatically added to their Fleet profile... that's it." Checked
// folders' own mechanism before rebuilding this (sharedFolders.ts +
// join/[token].tsx + the website's /join/{token} page) -- it's a
// flyregs.com/join/{token} link with a custom-scheme handoff, and
// app.json already whitelists /join/* as both a custom-scheme AND a real
// Universal Link intent filter, so this needed neither a new website page
// nor a new native build -- join/[token].tsx (the SAME route folders
// already use) now just tries joinSharedFolder first, then
// joinSharedAircraft, dispatching on whichever the token actually
// matches. share_code/share_code_role are unchanged as columns; they now
// hold a real 24-char token (same generator as folders' makeShareToken)
// instead of an 8-char human-typed code, so there's no manual entry left
// anywhere in the UI, same as folders.

export type CollaboratorRole = 'viewer' | 'editor'

function makeShareToken(): string {
  return Array.from({ length: 24 }, () => Math.random().toString(36)[2] ?? '0').join('')
}

export function buildAircraftShareLink(token: string): string {
  return `https://flyregs.com/join/${token}`
}

// Returns a link built from the aircraft's existing token if it already
// matches the requested role (so re-opening the share sheet doesn't mint
// a new link and invalidate the last one), otherwise generates a fresh
// token for that role. Regenerating changes the role for FUTURE joiners
// only -- it never touches collaborators who already joined under the
// previous link.
export async function getOrCreateShareLink(aircraftId: string, role: CollaboratorRole): Promise<{ link: string; token: string }> {
  const { data: existing } = await supabase
    .from('user_aircraft')
    .select('share_code, share_code_role')
    .eq('id', aircraftId)
    .maybeSingle()

  if (existing?.share_code && existing.share_code_role === role) {
    return { link: buildAircraftShareLink(existing.share_code), token: existing.share_code }
  }

  const token = makeShareToken()
  const { error } = await supabase
    .from('user_aircraft')
    .update({ share_code: token, share_code_role: role })
    .eq('id', aircraftId)
  if (error) throw error
  return { link: buildAircraftShareLink(token), token }
}

export interface JoinedAircraft {
  aircraftId: string
  nickname: string | null
  make: string
  model: string
  role: CollaboratorRole
}

// No .toUpperCase() -- unlike the old human-typed code, a link token is
// never re-typed by hand, and folders' own token format (mixed-case
// base36) would be corrupted by forcing case.
export async function joinSharedAircraft(token: string): Promise<JoinedAircraft> {
  const { data, error } = await supabase.rpc('join_shared_aircraft', { p_code: token.trim() })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('Invalid or expired invite link')
  return { aircraftId: row.out_aircraft_id, nickname: row.out_nickname, make: row.out_make, model: row.out_model, role: row.out_role }
}

export interface SharedAircraftSummary {
  aircraftId: string
  make: string
  model: string
  nickname: string | null
  typeDesignator: string | null
  year: number | null
  role: CollaboratorRole
  ownerLabel: string
}

// Aircraft shared WITH the current user (not owned) -- combine with the
// user's own owned aircraft to build the full My Fleet list.
export async function getMySharedAircraft(): Promise<SharedAircraftSummary[]> {
  const { data, error } = await supabase.rpc('get_my_shared_aircraft')
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    aircraftId: row.out_aircraft_id, make: row.out_make, model: row.out_model,
    nickname: row.out_nickname, typeDesignator: row.out_type_designator, year: row.out_year,
    role: row.out_role, ownerLabel: row.out_owner_label,
  }))
}

export interface AircraftCollaborator {
  userId: string
  displayLabel: string
  role: CollaboratorRole
  joinedAt: string
  lastViewedAt: string | null
  /** False until this specific person has actually opened the invite
   * link and accepted it -- the roster row for a pending invite shows
   * greyed out with an "Invited" badge instead of a real role badge. See
   * inviteCollaboratorByCallsign below. */
  accepted: boolean
}

export async function getAircraftCollaborators(aircraftId: string): Promise<AircraftCollaborator[]> {
  const { data, error } = await supabase.rpc('get_aircraft_collaborators', { p_aircraft_id: aircraftId })
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    userId: row.out_user_id, displayLabel: row.out_display_label, role: row.out_role,
    joinedAt: row.out_joined_at, lastViewedAt: row.out_last_viewed_at, accepted: !!row.out_accepted,
  }))
}

// RC: "we still need to track/log when an a/c is being shared... the
// 'name' [is] the person's Callsign from the app" -- targets a specific
// FlyRegs user by their Callsign (the same handle shown in Duels and
// every other collaborator list) instead of handing out an anonymous
// link anyone could redeem. Creates a pending aircraft_collaborators row
// (accepted_at null) with its own token; the roster shows it greyed out
// as "Invited" until that exact person opens the link, and the owner can
// revoke it beforehand via removeCollaborator (same function, same row).
export interface CallsignInvite {
  token: string
  userId: string
  callsign: string
}

export async function inviteCollaboratorByCallsign(
  aircraftId: string,
  callsign: string,
  role: CollaboratorRole
): Promise<CallsignInvite> {
  const token = makeShareToken()
  const { data, error } = await supabase.rpc('invite_aircraft_collaborator', {
    p_aircraft_id: aircraftId,
    p_callsign: callsign,
    p_role: role,
    p_token: token,
  })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('Could not create invite')
  return { token: row.out_token, userId: row.out_user_id, callsign: row.out_callsign }
}

// Change an EXISTING collaborator's role after they've already joined --
// unlike getOrCreateShareLink above (which only sets the role FUTURE
// joiners get), this touches the live aircraft_collaborators row directly.
// RC: "yes, build the a/c sharing change role capability."
//
// Deliberately an RPC, not a plain `.from('aircraft_collaborators').update(...)`
// the way sharedFolders.ts's setCollaboratorMode does it for folders -- this
// table has no owner-side UPDATE RLS policy at all (only the collaborator's
// own self-service last_viewed_at policy exists), and per
// sync/migrations_fix_collaborator_self_escalation.sql that self-service
// policy is exactly the shape that let a viewer self-escalate to editor on a
// sibling table before it was locked down with a column-restricting trigger.
// Rather than widen RLS on this table at all, this calls a SECURITY DEFINER
// RPC (see sync/migrations_aircraft_collaborator_role_change.sql) that checks
// auth.uid() owns the aircraft, rejects targeting your own row, and updates
// only the one row -- same narrow, auditable shape as every other sensitive
// collaborator mutation in this file.
export async function updateCollaboratorRole(aircraftId: string, userId: string, role: CollaboratorRole): Promise<void> {
  const { error } = await supabase.rpc('update_aircraft_collaborator_role', {
    p_aircraft_id: aircraftId,
    p_user_id: userId,
    p_role: role,
  })
  if (error) throw error
}

// Deleting the membership row genuinely does revoke access on the spot --
// has_aircraft_access() goes false immediately, verified live -- but that
// alone did NOT make the confirm's own promise true. my-aircraft/[id].tsx
// says, verbatim: "Remove X from this aircraft? They'll need a new invite
// to get back in." For someone invited by Callsign that holds (their row,
// and the invite_token on it, is gone). For someone who joined through the
// aircraft's OPEN share link it did not: user_aircraft.share_code was left
// live, and join_shared_aircraft()'s share_code branch happily re-inserts
// the exact collaborator the owner just removed. Confirmed live 2026-08-22:
// remove -> read access gone -> re-run join_shared_aircraft with the same
// token -> straight back in, same role.
//
// There is no "revoke link" control anywhere in the aircraft UI to fix it
// by hand either (folders have one -- saved.tsx's "Stop Sharing" ->
// unshareFolder -- aircraft never got the equivalent), so the owner had no
// way at all to close this. Retiring the link only when the removed person
// actually came in through it keeps a Callsign-only revoke from
// invalidating a link the owner is still circulating; the link is
// regenerated on the next Share tap either way (getOrCreateShareLink mints
// a fresh token when share_code is null), so nothing is lost permanently.
export async function removeCollaborator(aircraftId: string, userId: string): Promise<void> {
  // Read before the delete -- invite_token is what distinguishes a targeted
  // Callsign invite from an open-link join, and it disappears with the row.
  const { data: row } = await supabase
    .from('aircraft_collaborators')
    .select('invite_token')
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
    .maybeSingle()

  const { error } = await supabase
    .from('aircraft_collaborators')
    .delete()
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
  if (error) throw error

  if (row && !row.invite_token) {
    const { error: linkErr } = await supabase
      .from('user_aircraft')
      .update({ share_code: null, share_code_role: null })
      .eq('id', aircraftId)
    // Best-effort: access is already revoked above, this only closes the
    // re-entry path. Loud rather than silent so a failure is diagnosable.
    if (linkErr) console.error('Failed to retire the aircraft share link after a removal:', linkErr.message)
  }
}

export async function leaveSharedAircraft(aircraftId: string): Promise<void> {
  const { data } = await supabase.auth.getUser()
  const userId = data.user?.id
  if (!userId) return
  const { error } = await supabase
    .from('aircraft_collaborators')
    .delete()
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
  if (error) throw error
}

export type FleetRole = 'owner' | CollaboratorRole

export interface FleetAircraftSummary {
  aircraftId: string
  make: string
  model: string
  nickname: string | null
  typeDesignator: string | null
  year: number | null
  role: FleetRole
  openAdCount: number
  compliantAdCount: number
  overdueReminderCount: number
  currentHobbsHours: number | null
}

// The single data source for My Fleet's list screen -- owned AND shared
// aircraft in one call, each with its own real (not invented) alert
// counts. See migrations_aircraft_sharing.sql's get_fleet_summary() for
// why "overdue" is built from two genuinely separate facts (open AD count,
// overdue reminder count) instead of one conflated number -- RC caught the
// mockup's ambiguous single "Overdue Ā· 2" chip implying 2 aircraft were
// overdue when only 1 actually was. compliantAdCount (added later, see
// migrations_fleet_summary_compliant_ad_count.sql) is the third leg of the
// same idea -- RC caught the fleet card's own ring/legend silently
// substituting an AIRCRAFT-bucket count for a real compliant-AD-item count
// (no item-level number existed at all until this field), producing "0
// Compliant" against real device data that showed 3 complied ADs.
export async function getFleetSummary(): Promise<FleetAircraftSummary[]> {
  const { data, error } = await supabase.rpc('get_fleet_summary')
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    aircraftId: row.out_aircraft_id, make: row.out_make, model: row.out_model, nickname: row.out_nickname,
    typeDesignator: row.out_type_designator, year: row.out_year, role: row.out_role,
    openAdCount: row.out_open_ad_count, compliantAdCount: row.out_compliant_ad_count, overdueReminderCount: row.out_overdue_reminder_count,
    currentHobbsHours: row.out_current_hobbs_hours,
  }))
}

// How many saved aircraft the caller's tier is currently hiding from them.
// Non-zero only after a Premium -> Pro downgrade leaves more aircraft saved
// than Pro allows: get_fleet_summary() stops returning them (server-side, so
// no client can ask past it) but nothing is ever deleted, and this count is
// what lets the UI say that out loud instead of the aircraft appearing to
// have silently vanished. See sync/migrations_tier_cap_enforcement.sql.
// The caller's OWNED aircraft, oldest first -- the same order
// fleet_visible_cap() slices, so index >= cap is exactly the set the server
// is hiding. get_fleet_summary() can't answer this (it returns only what's
// visible, by design), and the downgrade picker needs the hidden ones' real
// names to let the user choose which one they keep.
//
// RC real-device gating audit, 2026-08-22: this used to be a plain
// user_aircraft select trusting RLS to scope it to "this user's own rows"
// -- true when this was written, but user_aircraft_own_select later grew a
// VISIBILITY CAP on top of ownership (migrations_fix_user_aircraft_select_
// returning.sql, closing a real read-bypass), so a plain select could only
// ever return the 1 already-visible aircraft -- the picker could never show
// the other N to choose from. get_owned_aircraft_oldest_first() is a narrow
// SECURITY DEFINER RPC scoped internally by auth.uid(), built specifically
// for this recovery flow -- it does not reopen the general read-bypass
// (the underlying RLS policy is untouched; this is a separate, deliberate
// exception for a user managing their own full set during a real downgrade).
export async function getOwnedAircraftOldestFirst(): Promise<
  { aircraftId: string; make: string; model: string; nickname: string | null }[]
> {
  const { data, error } = await supabase.rpc('get_owned_aircraft_oldest_first')
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    aircraftId: r.aircraft_id, make: r.make, model: r.model, nickname: r.nickname,
  }))
}

// Permanently deletes every owned aircraft EXCEPT the one being kept. RC's
// downgrade policy: "if going Prem>Pro, then we can't pay to 'store'
// anything for Pro users. in this case, they'd have to choose 1 a/c to take
// w/ them down to Pro." Only ever called from an explicit user choice with
// its own confirm -- nothing here runs on a timer or on downgrade itself.
//
// Same fix as getOwnedAircraftOldestFirst() above and for the same reason:
// a plain DELETE requires SELECT-visibility as a prerequisite to touch a
// row at all, so this used to silently affect 0 rows for every hidden
// aircraft. keep_only_aircraft() is the matching SECURITY DEFINER RPC,
// also scoped internally by auth.uid().
export async function keepOnlyAircraft(keepIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('keep_only_aircraft', { p_keep_ids: keepIds })
  if (error) throw error
}

// Shared write path for the self-reported hobbs/tach value -- used from the
// aircraft detail screen, the Fleet list row, and Home's quick-update CTA,
// so all three stay byte-identical instead of drifting. See
// sync/migrations_hobbs_tracking.sql.
export async function setAircraftCurrentHobbs(aircraftId: string, hours: number | null): Promise<void> {
  const { error } = await supabase
    .from('user_aircraft')
    .update({ current_hobbs_hours: hours, hobbs_updated_at: hours != null ? new Date().toISOString() : null })
    .eq('id', aircraftId)
  if (error) throw error
}

export async function getFleetHiddenCount(): Promise<number> {
  const { data, error } = await supabase.rpc('get_fleet_hidden_count')
  if (error) throw error
  return typeof data === 'number' ? data : 0
}

// How many aircraft the caller's CURRENT tier actually shows -- Pro: 1,
// Premium: unlimited, Plus/Free: 0 (Aircraft Manager isn't part of the
// tier at all). AircraftDowngradeGate needs this alongside
// getFleetHiddenCount() to tell "pick the one to keep" (cap 1) apart from
// "nothing can be kept, all N are being deleted" (cap 0) -- conflating
// those left a cap-0 downgrade unable to ever resolve the gate (any
// single "keep" choice was still over the real cap).
export async function getFleetVisibleCap(): Promise<number> {
  const { data, error } = await supabase.rpc('fleet_visible_cap')
  if (error) throw error
  return typeof data === 'number' ? data : 0
}

// A collaborator's own role on one aircraft, for the detail screen's
// role-gated controls. Not RPC-backed -- aircraft_collaborators already
// has a direct "see my own membership row" RLS policy
// (users_view_own_aircraft_collaborations), so a plain PostgREST select
// works. No row back means the caller is either the owner (confirmed
// separately by the aircraft's own successful fetch) or has no access at
// all -- RLS already guarantees the caller can't reach this far otherwise.
export async function getMyAircraftRole(aircraftId: string): Promise<CollaboratorRole | null> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return null
  const { data, error } = await supabase
    .from('aircraft_collaborators')
    .select('role')
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
    .is('left_at', null)
    .not('accepted_at', 'is', null)
    .maybeSingle()
  if (error) throw error
  return (data?.role as CollaboratorRole) ?? null
}

// Same gap, same fix as sharedFolders.ts's useFolderRealtime: this screen
// had ONLY useFocusEffect (screen-focus refresh) -- an owner who shares an
// aircraft and stays on this same screen never saw a collaborator's
// acceptance, an access-level change, or a reminder/AD update land until
// they navigated away and back. user_aircraft_equipment/reminders have no
// aircraft_id column (they FK through user_aircraft_id), so those two are
// subscribed unfiltered -- same tradeoff useFolderRealtime already accepts
// for synced_notes: RLS still authorizes each event per-row, so a
// completely unrelated aircraft's item change just costs one harmless extra
// reload of an already-open screen. Debounced so a burst of changes
// triggers one reload, not several.
export function useAircraftRealtime(aircraftId: string | undefined, onChange: () => void): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!aircraftId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onChangeRef.current(), 400)
    }
    // Same channel-reuse race and fix as useFolderRealtime (sharedFolders.ts)
    // -- supabase-js's client.channel(topic) reuses an EXISTING channel
    // object if one with the same topic string is still registered rather
    // than always creating a fresh one, so a rapid unmount+remount of this
    // screen could get back a stale, already-subscribed channel and throw
    // calling .on() on it again. Per-mount-unique topic name sidesteps it.
    const channel = supabase
      .channel(`aircraft-realtime-${aircraftId}-${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'aircraft_collaborators', filter: `aircraft_id=eq.${aircraftId}` }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_aircraft', filter: `id=eq.${aircraftId}` }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_aircraft_equipment' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_aircraft_reminders' }, debounced)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [aircraftId])
}
