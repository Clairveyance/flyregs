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
}

export async function getAircraftAdNotifications(userAircraftId: string): Promise<AircraftAdNotification[]> {
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .select('id, ad_number, matched_via, read_at, push_status, airworthiness_directives!inner(subject_heading, citation_publish_date)')
    .eq('user_aircraft_id', userAircraftId)
    .is('dismissed_at', null)
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
  }))
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
