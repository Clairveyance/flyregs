-- 2026-08-15. RC, after the Cessna "C172" fix: "our aircraft matching and
-- parts matching system... has to be much fuzzier than it is. It must be
-- able to accurately understand the similarity between c one seven two and
-- one seven two. And that must be expanded now because there are several
-- other aircraft and different manufacturers, and they all say or list the
-- aircraft slightly differently." Explicit directive: generalize the
-- Cessna-only fix, evidenced across manufacturers, not just patched for one.
--
-- Investigated real corpus data (not guessed) before building anything:
--   - Diamond: AD text is published "DA 40" / "DA 42" WITH A SPACE, but
--     owners overwhelmingly type "DA40"/"DA-40" without one. Confirmed live:
--     0 matches today for a "DA40"-saved aircraft against 16 real Diamond
--     ADs that plainly apply once the space is ignored.
--   - Piper: some AD `model` text has stray mid-token spaces from PDF
--     column-extraction ("PA-28- 161" instead of "PA-28-161") -- confirmed
--     a real AD (2016-07-21) that a cleanly-typed "PA-28-161" would silently
--     miss today.
--   - Beechcraft/Mooney: checked aircraft_type_designators for a Cessna-style
--     colloquial prefix (e.g. "BE58" for bare "58") -- found NO real
--     evidence of one; FAA registry and AD text both use the bare number
--     universally for these manufacturers. Did NOT invent a rule with no
--     evidence behind it -- same "a wrong designator is worse than none"
--     standard already established in src/lib/aircraftModels.ts.
--
-- Fix: a general normalize_aircraft_designator() that strips ALL
-- punctuation/whitespace and lowercases, applied to BOTH sides of every
-- comparison (the aircraft's saved model/type AND the AD's model/
-- applicability/subject_heading). This is manufacturer-agnostic and safe --
-- it only removes formatting characters, never changes which digits/letters
-- are present, so it can't turn one real designator into a different real
-- one. Combined with the existing Cessna-specific colloquial "C" prefix
-- strip (genuinely evidenced, kept as the one manufacturer-specific rule).
--
-- Deliberately did NOT add pg_trgm/fuzzy-typo matching on the designator
-- itself, despite RC's "fuzzier" framing and the precedent already set for
-- parts search (search_ad_parts_fuzzy). Tested first: similarity('pa28180',
-- 'pa28181') = 0.6 and similarity('172r','172rg') = 0.57 -- both comfortably
-- above any threshold that would also catch real typos, and BOTH pairs are
-- genuinely DIFFERENT real aircraft variants with their own AD histories
-- (Cherokee 180 vs Archer 181; 172R vs the older retractable-gear 172RG).
-- Trigram similarity can't tell "typo" from "adjacent real variant" for
-- short alphanumeric codes the way it safely can for prose/names (parts
-- search fuzzes NAMES, not model-variant numbers) -- a false "this AD
-- applies to you" is worse than a miss for a safety-relevant compliance
-- feature, so this was not enabled. Flagged to RC in the report rather than
-- silently built in.
create or replace function public.normalize_aircraft_designator(p_text text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]', '', 'g');
$$;

grant execute on function public.normalize_aircraft_designator(text) to authenticated, anon;

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
  select user_id, lower(trim(make)),
         public.normalize_aircraft_designator(model),
         public.normalize_aircraft_designator(coalesce(type_designator, ''))
    into v_user_id, v_make, v_model, v_type_designator
  from user_aircraft
  where id = p_user_aircraft_id;

  if v_user_id is null or v_user_id <> auth.uid() then
    return 0;
  end if;

  -- Cessna-only colloquial-prefix strip (post-normalization, so this is
  -- just "leading literal c before a digit" -- no hyphen handling needed,
  -- normalize_aircraft_designator already removed it). "c172" -> "172".
  if v_make like '%cessna%' then
    if v_model ~ '^c[0-9]' then
      v_model := substring(v_model from 2);
    end if;
    if v_type_designator ~ '^c[0-9]' then
      v_type_designator := substring(v_type_designator from 2);
    end if;
  end if;

  select count(*) into v_before from user_ad_notifications where user_aircraft_id = p_user_aircraft_id;

  insert into user_ad_notifications (user_id, user_aircraft_id, ad_number, matched_via)
  select v_user_id, p_user_aircraft_id, ad.ad_number, 'airframe'
  from airworthiness_directives ad
  where ad.make is not null
    and (lower(ad.make) like '%' || v_make || '%' or v_make like '%' || lower(ad.make) || '%')
    and (
      -- Case 1: structured model column, normalized on both sides.
      (ad.model is not null and (
        public.normalize_aircraft_designator(ad.model) like '%' || v_model || '%'
        or (v_type_designator <> '' and public.normalize_aircraft_designator(ad.model) like '%' || v_type_designator || '%')
      ))
      -- Case 2: applicability text, normalized on both sides.
      or (nullif(ad.applicability, '') is not null and (
        public.normalize_aircraft_designator(ad.applicability) like '%' || v_model || '%'
        or (v_type_designator <> '' and public.normalize_aircraft_designator(ad.applicability) like '%' || v_type_designator || '%')
      ))
      -- Case 3: subject_heading fallback, scoped to genuinely text-starved
      -- rows only (model AND applicability both absent), same as before.
      or (ad.model is null and nullif(ad.applicability, '') is null and nullif(ad.subject_heading, '') is not null and (
        public.normalize_aircraft_designator(ad.subject_heading) like '%' || v_model || '%'
        or (v_type_designator <> '' and public.normalize_aircraft_designator(ad.subject_heading) like '%' || v_type_designator || '%')
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
