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
  /** 'one_time' = done. 'recurring' = complied, and due again -- the next-due
   *  date/hours live on the linked user_aircraft_reminders row. null = a row
   *  complied before this distinction existed. */
  complianceKind: ComplianceKind | null
}

export type ComplianceKind = 'one_time' | 'recurring'

// dismissed (doesn't apply, remove from view) and complied (applies, done)
// are deliberately separate, both-optional terminal states -- an AD can be
// neither, or one, but never both at once in practice. Complied rows stay
// in this list (not filtered out like dismissed ones) since the whole
// point is a reviewable record of what's been done, not a todo list that
// just empties out.
export async function getAircraftAdNotifications(userAircraftId: string): Promise<AircraftAdNotification[]> {
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .select('id, ad_number, matched_via, read_at, push_status, complied_at, complied_note, compliance_kind, airworthiness_directives!inner(subject_heading, citation_publish_date)')
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
    complianceKind: r.compliance_kind ?? null,
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
/**
 * Record compliance with an AD.
 *
 * Robin (beta tester, 2026-09-02): tapping "mark complied" should ask
 * one-time or recurring, then capture WHEN it was complied with and HOW --
 * "installation of STC #####", "installation of upgraded component" -- so an
 * aircraft builds a real file of complied ADs rather than a checkbox.
 *
 * compliedAt is a caller-supplied DATE, not now(). Compliance is recorded
 * after the fact far more often than at the bench, and a record that always
 * says "today" is not a maintenance record.
 */
export async function markAdComplied(
  id: number,
  note: string | null,
  opts?: { kind?: ComplianceKind; compliedAt?: string },
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser()
  // An AD compliance record is the highest-stakes write in the app, so it
  // verifies that it actually changed something. PostgREST answers an UPDATE
  // matching ZERO rows with a SUCCESS, so `if (error) throw` alone would let a
  // refused write resolve cleanly and the screen would then show the AD as
  // COMPLIED WHEN IT IS NOT -- an airworthiness record the app invented.
  //
  // The screens already gate this on canEdit, so this is defence in depth
  // rather than the only guard -- and it is warranted, because canEdit is read
  // once when the screen loads. A collaborator demoted from editor to viewer
  // while sitting on that screen still sees the control until it refreshes,
  // and RLS (editors_manage_shared_ad_notifications) refuses them. That is the
  // reachable path. Guard on the side that cannot be stale.
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .update({
      complied_at: opts?.compliedAt ?? new Date().toISOString(),
      complied_by: auth.user?.id ?? null,
      complied_note: note?.trim() || null,
      compliance_kind: opts?.kind ?? 'one_time',
    })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error("You don't have permission to record compliance on this aircraft.")
}

export async function unmarkAdComplied(id: number): Promise<void> {
  // Same reasoning as markAdComplied: silently failing to CLEAR a compliance
  // record leaves the screen showing it as open while the record stands.
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .update({ complied_at: null, complied_by: null, complied_note: null, compliance_kind: null })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error("You don't have permission to change compliance on this aircraft.")
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
  // Same reasoning as markAdComplied. The caller (handleDismissAd) removes the
  // row from the list optimistically and rolls back on a throw, so a silent
  // success here is precisely what would make the AD vanish from the screen
  // and come back on the next load.
  const { data, error } = await supabase
    .from('user_ad_notifications')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error("You don't have permission to dismiss this AD.")
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

// backfillAircraftAds above only ever ADDS -- correct for "catch up on
// history when an aircraft or part is first added", but it meant an
// aircraft's Applicable ADs list could never recover from a corrected
// make/model/type_designator. Confirmed live 2026-08-22: a saved Cessna
// 172S (13 matched ADs) edited into a Piper PA-28-181 kept all 13 Cessna
// ADs and gained none of the Piper's, and the in-app refresh control only
// pushed it to 22 -- 13 of which a real PA-28-181 never matches. The type
// designator is the one field AD applicability is actually keyed on and
// the one most likely to be corrected after the fact, so the list being
// append-only made the app's headline promise ("ADs matched to what you
// actually fly") wrong for anyone who ever fixed a typo.
//
// resync clears the open airframe matches and lets the SAME matcher
// rebuild them from the aircraft's current identity -- see
// sync/migrations_aircraft_ad_resync.sql for what it deliberately spares
// (equipment matches, complied records, dismissed false positives) and why
// read/push state is preserved across the rebuild.
export async function resyncAircraftAds(userAircraftId: string): Promise<{ removed: number; added: number }> {
  const { data, error } = await supabase.rpc('resync_aircraft_ad_notifications', { p_user_aircraft_id: userAircraftId })
  if (error) throw error
  const row = (data as any[])?.[0]
  return { removed: row?.out_removed ?? 0, added: row?.out_added ?? 0 }
}
