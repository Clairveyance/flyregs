import { supabase } from '@/lib/supabase'

// AD parts/components catalog -- deliberately bounded to parts that have
// actually been named in a real AD's applicability text (see
// sync/extract_ad_parts.py and flyregs_decisions.md's AD Compliance-
// Tracking Scope Decision), not an attempt at a universal parts database.
// Tier boundary (revised 2026-07-28): searching/browsing this catalog is
// Plus; tagging a specific saved aircraft with a part is Premium (that's
// the personalized-tracking layer, gated separately in my-aircraft.tsx).

export type PartComponentType = 'engine' | 'propeller' | 'avionics' | 'airframe' | 'appliance' | 'other'

export interface AdPart {
  id: string
  name: string
  componentType: PartComponentType
  manufacturer: string | null
}

export interface PartMentionAd {
  adNumber: string
  subjectHeading: string
}

export async function searchParts(query: string, limit = 25): Promise<AdPart[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []
  const { data, error } = await supabase
    .from('ad_parts')
    .select('id, name, component_type, manufacturer')
    .eq('status', 'active')
    .ilike('name', `%${trimmed}%`)
    .order('name')
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, componentType: r.component_type, manufacturer: r.manufacturer }))
}

export async function getAdsForPart(partId: string): Promise<PartMentionAd[]> {
  const { data, error } = await supabase
    .from('ad_part_mentions')
    .select('ad_number, airworthiness_directives!inner(subject_heading)')
    .eq('part_id', partId)
  if (error) throw error
  return (data ?? []).map((r: any) => ({ adNumber: r.ad_number, subjectHeading: r.airworthiness_directives?.subject_heading ?? '' }))
}

export async function suggestPart(name: string, componentType: PartComponentType, manufacturer: string | null, userId: string): Promise<void> {
  const { error } = await supabase.from('ad_parts').insert({
    name: name.trim(),
    component_type: componentType,
    manufacturer: manufacturer?.trim() || null,
    source: 'user_suggested',
    status: 'pending_review',
    suggested_by: userId,
  })
  if (error) throw error
}

// ─── Equipment tags on a saved aircraft ────────────────────────────────────

export interface AircraftEquipment {
  id: string
  part: AdPart
}

export async function getAircraftEquipment(userAircraftId: string): Promise<AircraftEquipment[]> {
  const { data, error } = await supabase
    .from('user_aircraft_equipment')
    .select('id, ad_parts!inner(id, name, component_type, manufacturer)')
    .eq('user_aircraft_id', userAircraftId)
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    part: { id: r.ad_parts.id, name: r.ad_parts.name, componentType: r.ad_parts.component_type, manufacturer: r.ad_parts.manufacturer },
  }))
}

export async function addAircraftEquipment(userAircraftId: string, partId: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_equipment').insert({ user_aircraft_id: userAircraftId, part_id: partId })
  if (error) throw error
}

export async function removeAircraftEquipment(id: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_equipment').delete().eq('id', id)
  if (error) throw error
}

// ─── Maintenance reminders ──────────────────────────────────────────────────
// AD-linked (a specific compliance part) or general (ELT, transponder,
// annual, 100-hour) -- one mechanism for both, see flyregs_decisions.md.
// 100% user-input-driven: the app does date math and notifies, it verifies
// nothing independently.

export interface AircraftReminder {
  id: string
  userAircraftId: string
  title: string
  dueDate: string
  linkedAdNumber: string | null
  notes: string | null
}

export async function getAircraftReminders(userAircraftId: string): Promise<AircraftReminder[]> {
  const { data, error } = await supabase
    .from('user_aircraft_reminders')
    .select('id, user_aircraft_id, title, due_date, linked_ad_number, notes')
    .eq('user_aircraft_id', userAircraftId)
    .order('due_date')
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    userAircraftId: r.user_aircraft_id,
    title: r.title,
    dueDate: r.due_date,
    linkedAdNumber: r.linked_ad_number,
    notes: r.notes,
  }))
}

export async function addAircraftReminder(
  userId: string,
  userAircraftId: string,
  title: string,
  dueDate: string,
  linkedAdNumber?: string | null,
  notes?: string | null,
): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').insert({
    user_id: userId,
    user_aircraft_id: userAircraftId,
    title: title.trim(),
    due_date: dueDate,
    linked_ad_number: linkedAdNumber || null,
    notes: notes?.trim() || null,
  })
  if (error) throw error
}

export async function removeAircraftReminder(id: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').delete().eq('id', id)
  if (error) throw error
}
