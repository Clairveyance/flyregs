-- Editing an aircraft's identity never re-matched its Applicable ADs.
--
-- Confirmed live 2026-08-22 against real accounts:
--   * Saved a Cessna 172S  -> backfill matched 13 ADs.
--   * Edited it to a Piper PA-28-181 (exactly what
--     EditAircraftModal.handleSave writes: make/model/type_designator in
--     one UPDATE) -> STILL showing the same 13 Cessna ADs, and none of the
--     Piper's own.
--   * Tapped the AD section's own refresh control (handleBackfillAds ->
--     backfill_aircraft_ad_notifications) -> 22 ADs. A fresh, correctly
--     entered PA-28-181 matches 9. So 13 of the 22 belonged to an aircraft
--     the owner does not have, and there was no way at all to clear them
--     short of dismissing each one by hand.
--
-- Root cause: backfill_aircraft_ad_notifications() is INSERT-only by
-- design (it exists to catch up on history, and ON CONFLICT DO NOTHING is
-- what protects a dismissed false positive from coming back). Nothing in
-- the app ever RE-evaluated an existing airframe match, and the type
-- designator -- the single field AD applicability is actually matched on,
-- and the one the Add form calls out as required "so we can match
-- Airworthiness Directives correctly" -- is exactly the field an owner is
-- most likely to correct after the fact.
--
-- This is the missing half: clear the open airframe matches, then let the
-- existing, untouched matcher rebuild them from the aircraft's CURRENT
-- make/model/type. The match rule itself is deliberately not duplicated or
-- refactored here -- backfill_aircraft_ad_notifications() stays the one
-- and only definition of "does this AD apply", so the two can never drift.
--
-- Scope of the delete, and what it deliberately spares:
--   * matched_via = 'equipment' -- part matches don't depend on make/model
--     at all, so re-deriving them would be pure churn.
--   * complied_at -- a compliance mark is a maintenance RECORD the owner
--     entered. It survives even if the AD no longer matches; deleting one
--     because a model was corrected would be data loss.
--   * dismissed_at -- same reasoning as migrations_ad_dismiss.sql: the row
--     is what suppresses a known false positive on every future sync.
--
-- read_at / push_* are snapshotted and restored for every AD that survives
-- the rebuild, so a resync doesn't flood the list with fake unread dots for
-- ADs the owner has already looked at. Only genuinely new matches come back
-- unread, which is correct.
--
-- Owner-only, matching backfill_aircraft_ad_notifications() itself (an
-- editor collaborator can't change the aircraft's identity in a way that
-- would need this, and the AD refresh control is already isOwner-gated).
CREATE OR REPLACE FUNCTION public.resync_aircraft_ad_notifications(p_user_aircraft_id uuid)
RETURNS TABLE(out_removed integer, out_added integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_before text[];
  v_after  text[];
  v_saved  jsonb;
begin
  out_removed := 0;
  out_added := 0;

  if not exists (
    select 1 from user_aircraft where id = p_user_aircraft_id and user_id = auth.uid()
  ) then
    return next;
    return;
  end if;

  select coalesce(array_agg(ad_number), '{}')
    into v_before
    from user_ad_notifications
   where user_aircraft_id = p_user_aircraft_id
     and matched_via = 'airframe'
     and complied_at is null
     and dismissed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ad', ad_number, 'read', read_at,
           'ps', push_status, 'pt', push_sent_at, 'pe', push_error)), '[]'::jsonb)
    into v_saved
    from user_ad_notifications
   where user_aircraft_id = p_user_aircraft_id
     and matched_via = 'airframe'
     and complied_at is null
     and dismissed_at is null;

  delete from user_ad_notifications
   where user_aircraft_id = p_user_aircraft_id
     and matched_via = 'airframe'
     and complied_at is null
     and dismissed_at is null;

  perform public.backfill_aircraft_ad_notifications(p_user_aircraft_id);

  update user_ad_notifications n
     set read_at     = (x->>'read')::timestamptz,
         push_status = x->>'ps',
         push_sent_at = (x->>'pt')::timestamptz,
         push_error  = x->>'pe'
    from jsonb_array_elements(v_saved) x
   where n.user_aircraft_id = p_user_aircraft_id
     and n.matched_via = 'airframe'
     and n.ad_number = x->>'ad';

  select coalesce(array_agg(ad_number), '{}')
    into v_after
    from user_ad_notifications
   where user_aircraft_id = p_user_aircraft_id
     and matched_via = 'airframe'
     and complied_at is null
     and dismissed_at is null;

  select count(*)::int into out_removed from unnest(v_before) b where not (b = any(v_after));
  select count(*)::int into out_added   from unnest(v_after)  a where not (a = any(v_before));
  return next;
end;
$$;

REVOKE ALL ON FUNCTION public.resync_aircraft_ad_notifications(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.resync_aircraft_ad_notifications(uuid) TO authenticated;
