-- Second pass on the same backfill_aircraft_ad_notifications() function
-- touched by migrations_fix_ad_backfill_empty_applicability.sql, same
-- investigation (RC, live Cirrus SR22 test aircraft). Re-tested after
-- that first fix and found it did NOT close the real gap: AD 2012-01-11
-- has model = 'and serial number' -- a genuine OCR/extraction fragment,
-- not a real designator -- but because it's non-null, Case 1 alone gates
-- the match ("ad.model is not null and (...)"), and Cases 2/3 explicitly
-- require "ad.model is null" to even run. So this AD's real, correct,
-- complete applicability text ("Cirrus Design Corporation Model SR22T
-- airplanes, serial numbers...") never gets checked at all -- the
-- garbled model value doesn't just fail to match, it actively BLOCKS the
-- good text sitting right next to it from being tried.
--
-- Scoped a corpus-wide check before writing this: 51 ADs have a model
-- value that reads as a prose/table fragment rather than a real
-- designator (grep for leading "and/the/serial number/..." -- see
-- PROJECT_NOTES/flyregs_pending.md for the query and full list). Most of
-- those still happen to have SOME real designator token embedded further
-- in (e.g. "CL-600-2D15 (Regional Jet Series 705) airplanes and Model
-- CL-600-2D24...") so they already match fine; a much smaller subset (~9)
-- have NO real designator anywhere in model, like this one. Rather than
-- regex-classifying "is this model value garbled" -- fragile, and the
-- exact kind of blind pattern-matching workaround already rejected once
-- this session for the pending_review auto-merge -- the correct general
-- fix is structural: stop treating "model populated" and "check
-- applicability/subject_heading" as mutually exclusive. A populated but
-- non-matching model value should fall through to the text fields, not
-- dead-end the whole AD. This can only ever ADD matches versus the prior
-- version (every condition that used to match still does -- Case 1 is
-- untouched, Cases 2/3's inner match conditions are unchanged, only the
-- "ad.model is null" gate in front of them is dropped), so it carries no
-- risk of losing a match that worked before.
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
      -- Case 1: structured model column populated and it matches --
      -- unchanged, most precise, tried first.
      (ad.model is not null and (
        lower(ad.model) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.model) like '%' || v_type_designator || '%')
      ))
      -- Case 2: applicability text matches -- tried whenever applicability
      -- text exists, NOT only when model is null/absent. This is the fix:
      -- a populated-but-non-matching (e.g. garbled) model value no longer
      -- blocks this from running.
      or (nullif(ad.applicability, '') is not null and (
        lower(ad.applicability) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.applicability) like '%' || v_type_designator || '%')
      ))
      -- Case 3: subject_heading fallback -- kept scoped to genuinely
      -- text-starved rows only (model AND applicability both absent), same
      -- as before, since subject_heading is hard-truncated at ingest and
      -- is the least reliable signal of the three.
      or (ad.model is null and nullif(ad.applicability, '') is null and nullif(ad.subject_heading, '') is not null and (
        lower(ad.subject_heading) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.subject_heading) like '%' || v_type_designator || '%')
      ))
      -- Case 4: genuinely no model text ANYWHERE on this AD -- true last
      -- resort, make-only match.
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
