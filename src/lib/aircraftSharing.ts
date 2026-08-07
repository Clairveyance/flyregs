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
export async function getOrCreateShareLink(aircraftId: string, role: CollaboratorRole): Promise<string> {
  const { data: existing } = await supabase
    .from('user_aircraft')
    .select('share_code, share_code_role')
    .eq('id', aircraftId)
    .maybeSingle()

  if (existing?.share_code && existing.share_code_role === role) return buildAircraftShareLink(existing.share_code)

  const token = makeShareToken()
  const { error } = await supabase
    .from('user_aircraft')
    .update({ share_code: token, share_code_role: role })
    .eq('id', aircraftId)
  if (error) throw error
  return buildAircraftShareLink(token)
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
}

export async function getAircraftCollaborators(aircraftId: string): Promise<AircraftCollaborator[]> {
  const { data, error } = await supabase.rpc('get_aircraft_collaborators', { p_aircraft_id: aircraftId })
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    userId: row.out_user_id, displayLabel: row.out_display_label, role: row.out_role,
    joinedAt: row.out_joined_at, lastViewedAt: row.out_last_viewed_at,
  }))
}

export async function removeCollaborator(aircraftId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('aircraft_collaborators')
    .delete()
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
  if (error) throw error
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
  overdueReminderCount: number
  currentHobbsHours: number | null
}

// The single data source for My Fleet's list screen -- owned AND shared
// aircraft in one call, each with its own real (not invented) alert
// counts. See migrations_aircraft_sharing.sql's get_fleet_summary() for
// why "overdue" is built from two genuinely separate facts (open AD count,
// overdue reminder count) instead of one conflated number -- RC caught the
// mockup's ambiguous single "Overdue Ā· 2" chip implying 2 aircraft were
// overdue when only 1 actually was.
export async function getFleetSummary(): Promise<FleetAircraftSummary[]> {
  const { data, error } = await supabase.rpc('get_fleet_summary')
  if (error) throw error
  return (data ?? []).map((row: any) => ({
    aircraftId: row.out_aircraft_id, make: row.out_make, model: row.out_model, nickname: row.out_nickname,
    typeDesignator: row.out_type_designator, year: row.out_year, role: row.out_role,
    openAdCount: row.out_open_ad_count, overdueReminderCount: row.out_overdue_reminder_count,
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
// names to let the user choose which one they keep. Plain select rather
// than a new RPC: user_aircraft's own RLS already scopes an owner to their
// own rows.
export async function getOwnedAircraftOldestFirst(): Promise<
  { aircraftId: string; make: string; model: string; nickname: string | null }[]
> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return []
  const { data, error } = await supabase
    .from('user_aircraft')
    .select('id, make, model, nickname, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    aircraftId: r.id, make: r.make, model: r.model, nickname: r.nickname,
  }))
}

// Permanently deletes every owned aircraft EXCEPT the one being kept. RC's
// downgrade policy: "if going Prem>Pro, then we can't pay to 'store'
// anything for Pro users. in this case, they'd have to choose 1 a/c to take
// w/ them down to Pro." Only ever called from an explicit user choice with
// its own confirm -- nothing here runs on a timer or on downgrade itself.
export async function keepOnlyAircraft(keepIds: string[]): Promise<void> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  let q = supabase.from('user_aircraft').delete().eq('user_id', userId)
  if (keepIds.length > 0) q = q.not('id', 'in', `(${keepIds.join(',')})`)
  const { error } = await q
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
    .maybeSingle()
  if (error) throw error
  return (data?.role as CollaboratorRole) ?? null
}
