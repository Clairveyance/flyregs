-- Found while live-testing the aircraft-to-AD backfill match RC asked
-- about (a real Cirrus SR22 test aircraft, 2026-08-14): AD 2008-11-18
-- (a real, genuine Cirrus SR20-specific AD) has `model = NULL` but
-- `applicability = ''` (empty string, not NULL) -- and every CASE branch
-- in backfill_aircraft_ad_notifications() gates on `ad.applicability is
-- null`, which is FALSE for an empty string. Case 2 (check applicability
-- text) never fires because `is null` says no; Case 3 (fall back to
-- subject_heading, which DOES say "SR20") never fires for the same
-- reason; Case 4 (true last-resort make-only match) also never fires,
-- since it requires BOTH applicability and subject_heading to be null.
-- Net effect: this AD silently matches NO Cirrus aircraft at all, not
-- just this specific SR22 (an SR20 owner would miss it too, despite
-- SR20 being right there in subject_heading). SQL's `is null` was never
-- going to catch this -- the fix is normalizing '' to null once, with
-- nullif(), before any of the CASE logic runs, so an empty capture
-- behaves exactly like an absent one everywhere downstream.
--
-- Scope note: this fixes the NULL-vs-empty-string data SHAPE issue only.
-- A second, distinct issue was found in the same investigation --  some
-- ADs have a non-null but genuinely GARBLED `model` column value (e.g.
-- literally "and serial number", a parsing artifact) that blocks the
-- applicability-text fallback from ever being tried even though the real
-- applicability text has a clean, matchable model name in it -- that's a
-- content/data-quality issue in the model column itself (same family as
-- the already-tracked AD model-backfill work), not a shape issue this
-- migration can safely paper over without risking a different kind of
-- false match. Flagged in PROJECT_NOTES/flyregs_pending.md, not touched
-- here.
CREATE OR REPLACE FUNCTION public.backfill_aircraft_ad_notifications(p_user_aircraft_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_make text;
  v_model text;
  v_type_designator text;
  v_before integer;
  v_after integer;
begin
  select user_id, lower(trim(make)), lower(trim(model)), lower(trim(coalesce(type_designator, '')))
    into v_user_id, v_make, v_model, v_type_designator
  from user_aircraft
  where id = p_user_aircraft_id;

  if v_user_id is null or v_user_id <> auth.uid() then
    return 0;
  end if;

  select count(*) into v_before from user_ad_notifications where user_aircraft_id = p_user_aircraft_id;

  insert into user_ad_notifications (user_id, user_aircraft_id, ad_number, matched_via)
  select v_user_id, p_user_aircraft_id, ad.ad_number, 'airframe'
  from airworthiness_directives ad
  where ad.make is not null
    and (lower(ad.make) like '%' || v_make || '%' or v_make like '%' || lower(ad.make) || '%')
    and (
      -- Case 1: structured model column populated -- unchanged, most precise.
      (ad.model is not null and (
        lower(ad.model) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.model) like '%' || v_type_designator || '%')
      ))
      -- Case 2: model is null but full applicability text is available --
      -- nullif() treats an empty-string capture the same as a genuinely
      -- absent one (the actual fix -- see header comment).
      or (ad.model is null and nullif(ad.applicability, '') is not null and (
        lower(ad.applicability) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.applicability) like '%' || v_type_designator || '%')
      ))
      -- Case 3: no applicability text either -- fall back to the
      -- (truncated) subject_heading.
      or (ad.model is null and nullif(ad.applicability, '') is null and nullif(ad.subject_heading, '') is not null and (
        lower(ad.subject_heading) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.subject_heading) like '%' || v_type_designator || '%')
      ))
      -- Case 4: genuinely no model text ANYWHERE on this AD to check
      -- against -- true last resort, make-only match (the original
      -- behavior, now scoped to only the rows that actually need it).
      or (ad.model is null and nullif(ad.applicability, '') is null and nullif(ad.subject_heading, '') is null)
    )
  on conflict (user_aircraft_id, ad_number) do nothing;

  insert into user_ad_notifications (user_id, user_aircraft_id, ad_number, matched_via)
  select v_user_id, p_user_aircraft_id, apm.ad_number, 'equipment'
  from user_aircraft_equipment uae
  join ad_part_mentions apm on apm.part_id = uae.part_id
  where uae.user_aircraft_id = p_user_aircraft_id
  on conflict (user_aircraft_id, ad_number) do nothing;

  select count(*) into v_after from user_ad_notifications where user_aircraft_id = p_user_aircraft_id;
  return v_after - v_before;
end;
$function$;
