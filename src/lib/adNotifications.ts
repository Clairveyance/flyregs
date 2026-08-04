import { supabase } from '@/lib/supabase'

// Applicable-ADs list for a saved aircraft's own folder screen, backed by
// user_ad_notifications (sync/migrations_ad_notification_log.sql) -- one
// row per (aircraft, AD) match, written both by the recurring
// scripts/send-ad-alerts.mjs sync (new/updated ADs) and by
// backfillAircraftAds below (everything that already existed when the
// aircraft/part was added). See that migration's own header for the
// reliability gap this closes: before this, a matched AD's only trace was
// a push notification that may or may not have been delivered, with no
// durable record either way.

export interface AircraftAdNotification {
  id: number
  adNumber: string
  subjectHeading: string
  citationPublishDate: string | null
  matchedVia: 'airframe' | 'equipment'
  readAt: string | null
  pushStatus: 'sent' | 'error' | null
  compliedAt: string | null
  compliedNote: string | null
}

// dismissed (doesn't apply, remove from view) and complied (applies, done)
// are deliberately separate, both-optional terminal states -- an AD can be
// neither, or one, but never both at once in practice. Complied rows stay
// in this list (not filtered out like dismissed ones) since the whole
// point is a reviewable record of what's been done, not a todo list that
// just empties out.
export async function getAircraftAdNotifications(userAircraftId: string): Promise<AircraftAdNotification[]> {
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .select('id, ad_number, matched_via, read_at, push_status, complied_at, complied_note, airworthiness_directives!inner(subject_heading, citation_publish_date)')
    .eq('user_aircraft_id', userAircraftId)
    .is('dismissed_at', null)
    .order('complied_at', { ascending: true, nullsFirst: true })
    .order('read_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    adNumber: r.ad_number,
    subjectHeading: r.airworthiness_directives?.subject_heading ?? '',
    citationPublishDate: r.airworthiness_directives?.citation_publish_date ?? null,
    matchedVia: r.matched_via,
    readAt: r.read_at,
    pushStatus: r.push_status,
    compliedAt: r.complied_at,
    compliedNote: r.complied_note,
  }))
}

// RC: "yeah build the Fleet schema. keep it feature rich but avoid any
// word use they smells of legal or liability on our part. can be handled
// w/ CTA disclaimer if need be to log that we advised." Self-reported,
// same register as the equipment/reminders disclaimer already uses --
// this records what the owner/editor told FlyRegs, not an independent
// compliance determination. The confirm Alert at the call site IS the
// "log that we advised" moment; no separate acknowledgment flag needed.
export async function markAdComplied(id: number, note: string | null): Promise<void> {
  const { data: auth } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('user_ad_notifications')
    .update({ complied_at: new Date().toISOString(), complied_by: auth.user?.id ?? null, complied_note: note?.trim() || null })
    .eq('id', id)
  if (error) throw error
}

export async function unmarkAdComplied(id: number): Promise<void> {
  const { error } = await supabase
    .from('user_ad_notifications')
    .update({ complied_at: null, complied_by: null, complied_note: null })
    .eq('id', id)
  if (error) throw error
}

export async function markAdNotificationRead(id: number): Promise<void> {
  const { error } = await supabase
    .from('user_ad_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null) // don't stomp an already-set read_at with a slightly different timestamp
  if (error) throw error
}

// Soft delete -- see migrations_ad_dismiss.sql for why the row is kept
// (dismissed_at set) rather than actually removed: the UNIQUE(user_aircraft_id,
// ad_number) constraint is what stops the next backfill/weekly sync from
// silently re-adding the exact false-positive match the user just removed.
export async function dismissAdNotification(id: number): Promise<void> {
  const { error } = await supabase
    .from('user_ad_notifications')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// Runs the same match rule scripts/send-ad-alerts.mjs uses, but against
// the FULL AD corpus instead of just this run's touched set -- see
// sync/migrations_ad_backfill.sql's own header. Call right after saving a
// new aircraft, and again after tagging new equipment (a newly-tagged part
// can have real historical ADs of its own the airframe match never would
// have caught). Returns how many NEW rows were actually added, so the
// caller can show a real "found N applicable ADs" result instead of a
// silent no-op.
export async function backfillAircraftAds(userAircraftId: string): Promise<number> {
  const { data, error } = await supabase.rpc('backfill_aircraft_ad_notifications', { p_user_aircraft_id: userAircraftId })
  if (error) throw error
  return (data as number) ?? 0
}
