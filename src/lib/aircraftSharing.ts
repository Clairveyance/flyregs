import { supabase } from '@/lib/supabase'

// Fleet aircraft sharing -- viewer/editor collaborators. Mirrors
// sharedFolders.ts's shape closely, but folders are read-only by design,
// so this adds the role concept folders never needed (RC: "you'll need to
// build in the 'editor' side of the perms"). v1 uses a short manually-
// entered code rather than folders' flyregs.com/join/{token} website
// landing page -- see migrations_aircraft_sharing.sql's own header for why.

export type CollaboratorRole = 'viewer' | 'editor'

function makeShareCode(): string {
  // 8 unambiguous uppercase chars (no 0/O/1/I) -- short enough to read
  // aloud or retype from a text message, same reasoning as most consumer
  // app invite codes.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

// Returns the aircraft's existing code if it already matches the requested
// role (so re-opening the share sheet doesn't mint a new code and
// invalidate the last one), otherwise generates a fresh one for that role.
// Regenerating changes the role for FUTURE joiners only -- it never
// touches collaborators who already joined under the previous code.
export async function getOrCreateShareCode(aircraftId: string, role: CollaboratorRole): Promise<string> {
  const { data: existing } = await supabase
    .from('user_aircraft')
    .select('share_code, share_code_role')
    .eq('id', aircraftId)
    .maybeSingle()

  if (existing?.share_code && existing.share_code_role === role) return existing.share_code

  const code = makeShareCode()
  const { error } = await supabase
    .from('user_aircraft')
    .update({ share_code: code, share_code_role: role })
    .eq('id', aircraftId)
  if (error) throw error
  return code
}

export interface JoinedAircraft {
  aircraftId: string
  nickname: string | null
  make: string
  model: string
  role: CollaboratorRole
}

export async function joinSharedAircraft(code: string): Promise<JoinedAircraft> {
  const { data, error } = await supabase.rpc('join_shared_aircraft', { p_code: code.trim().toUpperCase() })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('Invalid or expired invite code')
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
  }))
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
