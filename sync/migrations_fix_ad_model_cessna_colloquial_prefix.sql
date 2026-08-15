-- 2026-08-15. RC built a test Cessna 172 to verify My Fleet's ring v3 and
-- got "0 applicable ADs" -- surprising, since 172s have a large real AD
-- history (23+ ADs reference "172" in this corpus). RC: "that wouldn't be
-- the case for a 172."
--
-- Root cause: the aircraft's model field was saved as "C172" -- the way
-- essentially every pilot colloquially refers to the type -- but the FAA
-- type-certificate designator, and every AD in this corpus, uses the bare
-- number ("172", "172R", "172S", never "C172" with the manufacturer letter
-- attached). backfill_aircraft_aircraft_notifications() does a plain
-- substring match (does the AD's model/applicability/subject_heading text
-- CONTAIN the aircraft's saved model string) -- "c172" is never a substring
-- of "...Models 172R, 172S..." because of the space between "Models" and
-- "172", so every single Cessna 172 AD silently fails to match for anyone
-- who types the model the way they'd naturally say it out loud. Confirmed
-- by checking the corpus directly: of 23 Cessna-172-relevant ADs, only 2
-- have a populated `model` column and neither contains the substring
-- "c172" either.
--
-- This is Cessna-specific, not a generic "strip leading letters" rule --
-- Piper's "PA-28" prefix IS the real designator (stripping it would BREAK
-- matching), and this corpus never shows a real Cessna AD designator
-- carrying a "C" prefix, so stripping a leading "C"/"C-" is safe whenever
-- make is Cessna: it only ever helps or is a no-op, never a false match,
-- since there's no case where an AD's own text has "c172" for real.
create or replace function public.backfill_aircraft_ad_notifications(p_user_aircraft_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Cessna-only colloquial-prefix strip -- see file header. "c172" -> "172",
  -- "c-182" -> "182". Never touches other manufacturers' designators, which
  -- can legitimately carry their own letter prefixes (Piper's PA-28, etc).
  if v_make like '%cessna%' then
    if v_model ~ '^c-?[0-9]' then
      v_model := regexp_replace(v_model, '^c-?', '');
    end if;
    if v_type_designator ~ '^c-?[0-9]' then
      v_type_designator := regexp_replace(v_type_designator, '^c-?', '');
    end if;
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
