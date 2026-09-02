-- AD make prefilter was dropping REAL applicable ADs (2026-09-03)
--
-- Found by the overnight notification audit and independently re-verified
-- against the live saved aircraft before changing anything. This is the app's
-- core safety promise, so it is the most important fix of the night.
--
-- Mirrors the identical change in scripts/send-ad-alerts.mjs. The two matchers
-- MUST stay in step: resync_aircraft_ad_notifications() DELETES open airframe
-- matches and rebuilds them from this function, so a divergence would silently
-- delete rows the push path had correctly created.

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
  select user_id, lower(trim(make)),
         public.normalize_aircraft_designator(model),
         public.normalize_aircraft_designator(coalesce(type_designator, ''))
    into v_user_id, v_make, v_model, v_type_designator
  from user_aircraft
  where id = p_user_aircraft_id;

  -- `is distinct from`, not `<>`: with no JWT auth.uid() is NULL and
  -- `v_user_id <> NULL` evaluates to NULL, which plpgsql does not treat as
  -- true -- so the guard fell through and an unauthenticated caller could
  -- force a backfill on any aircraft id. Verified in-DB.
  -- has_aircraft_access(..., true) added so an EDITOR collaborator's part tag
  -- actually produces AD matches. RLS lets an editor add a part and faq.tsx
  -- promises exactly that, but this owner-only guard made it a silent no-op:
  -- 0 returned, no error, and no self-correction later. The DELETE side
  -- (prune_orphaned_equipment_ad_notifications) already accepts editors.
  if v_user_id is null
     or (v_user_id is distinct from auth.uid()
         and not public.has_aircraft_access(p_user_aircraft_id, true)) then
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
    -- MAKE GATE, or a specific-enough DESIGNATOR HIT (2026-09-03).
    -- An AD's `make` is the type-certificate holder or the appliance
    -- manufacturer, often a different company from the name on the airframe,
    -- so gating on make alone silently dropped real applicable ADs before
    -- their applicability text was ever read. Measured live: LAKE LA-4-200
    -- matched 2 of the 6 ADs naming "LA-4-200" (the rest are filed under
    -- "Revo, Incorporated", the Lake TC holder); Cessna 172S matched 13 of 16,
    -- dropping AD 2018-02-04 -- the Aerospace Welding muffler AD the parts
    -- feature was built around.
    -- The >= 4 normalized-character floor is measured, not guessed:
    -- '172s' -> 17 ADs, 'la4200' -> 6, but bare '172' -> 163.
    -- Mirrors scripts/send-ad-alerts.mjs exactly; the two MUST stay in step,
    -- because resync_aircraft_ad_notifications() deletes open airframe matches
    -- and rebuilds from this rule.
    and (
      (lower(ad.make) like '%' || v_make || '%' or v_make like '%' || lower(ad.make) || '%')
      or (length(v_type_designator) >= 4 and (
            public.normalize_aircraft_designator(coalesce(ad.model, '')) like '%' || v_type_designator || '%'
            or public.normalize_aircraft_designator(coalesce(nullif(ad.applicability, ''), ad.subject_heading, '')) like '%' || v_type_designator || '%'
      ))
    )
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
$function$

