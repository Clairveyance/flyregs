-- ============================================================================
-- AD backfill on aircraft add/equipment-tag  --  2026-07-31
--
-- RC: "when a user 'builds' an a/c in their profile and adds a parts list,
-- our system needs to be able to 'backfill' that a/c and parts list with
-- actual current/recent/previous ADs that are applicable... We don't ONLY
-- want to give them future ADs, but also those that may currently exist."
--
-- send-ad-alerts.mjs only ever matches ADs the CURRENT sync run touched --
-- correct for its job (targeted alerts on what's new), but it means a
-- newly-added aircraft (or newly-tagged part) starts with an empty
-- Applicable ADs list even if 40 real ADs already apply to it. This
-- function runs the identical matching rule against the FULL AD corpus,
-- not just what's new, so a fresh aircraft/part starts populated instead
-- of silently missing everything that predates it being added.
--
-- Deliberately a plain callable function (SECURITY DEFINER, so it can read
-- airworthiness_directives/ad_part_mentions under RLS) rather than a
-- trigger -- called explicitly right after an insert from the client, so
-- the caller can show a real "found N applicable ADs" result instead of a
-- silent background trigger the UI has no way to react to.
--
-- REVISED 2026-08-01 -- null-model fallback precision fix. RC, live,
-- screenshot: a saved Cessna 172S showed 65 Applicable ADs, most for
-- completely different Cessna models (182S, 206H, 402C, Citation jets).
-- Root cause: the ORIGINAL version below matched on make ALONE whenever
-- ad.model was NULL, reasoning "an occasional extra row costs far less
-- than silently excluding a real applicable AD." Measured the real scope
-- once this showed up live: 1,592/5,023 ADs corpus-wide (31.7%) have
-- model = NULL, and for Cessna specifically (same bidirectional
-- make-substring rule this function uses) it's 65/87 (~75%) -- nowhere
-- near "occasional." Fix: when ad.model is null, check the aircraft's
-- model/type substring against ad.applicability (full untruncated text,
-- available for 583 of the 1,592 null-model rows) or ad.subject_heading
-- (available for effectively all of them, but hard-truncated at 65
-- characters at ingest -- confirmed by direct query) before falling all
-- the way through to a true make-only match, which is now scoped to only
-- the rows where NEITHER text field has anything to check against.
-- ============================================================================

create or replace function public.backfill_aircraft_ad_notifications(p_user_aircraft_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  -- SECURITY DEFINER bypasses RLS to read airworthiness_directives/
  -- ad_part_mentions -- this check is what stops an authenticated caller
  -- from forcing a backfill run against an aircraft they don't own (writes
  -- would still land under the AIRCRAFT's real owner either way since
  -- v_user_id comes from the row, not the caller, but there's no reason to
  -- let anyone trigger work against a `user_aircraft_id` that isn't theirs).
  if v_user_id is null or v_user_id <> auth.uid() then
    return 0;
  end if;

  select count(*) into v_before from user_ad_notifications where user_aircraft_id = p_user_aircraft_id;

  -- Airframe match -- mirrors send-ad-alerts.mjs's bidirectional substring
  -- rule exactly (see that script's own comment for why): an AD's `make`
  -- is the FAA's long-form type-certificate-holder string, never the
  -- common name a user types, so neither direction of containment can be
  -- assumed.
  insert into user_ad_notifications (user_id, user_aircraft_id, ad_number, matched_via)
  select v_user_id, p_user_aircraft_id, ad.ad_number, 'airframe'
  from airworthiness_directives ad
  where ad.make is not null
    and (lower(ad.make) like '%' || v_make || '%' or v_make like '%' || lower(ad.make) || '%')
    and (
      -- Case 1: structured model column populated -- most precise, unchanged.
      (ad.model is not null and (
        lower(ad.model) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.model) like '%' || v_type_designator || '%')
      ))
      -- Case 2: model is null but full applicability text is available --
      -- check the aircraft's model/type substring against that instead of
      -- assuming a match.
      or (ad.model is null and ad.applicability is not null and (
        lower(ad.applicability) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.applicability) like '%' || v_type_designator || '%')
      ))
      -- Case 3: no applicability text either -- fall back to the
      -- (truncated) subject_heading, which still narrows things down for
      -- any model name that lands in its first ~65 characters.
      or (ad.model is null and ad.applicability is null and ad.subject_heading is not null and (
        lower(ad.subject_heading) like '%' || v_model || '%'
        or (v_type_designator <> '' and lower(ad.subject_heading) like '%' || v_type_designator || '%')
      ))
      -- Case 4: genuinely no model text ANYWHERE on this AD to check
      -- against -- true last resort, make-only match (the original
      -- behavior, now scoped to only the rows that actually need it).
      or (ad.model is null and ad.applicability is null and ad.subject_heading is null)
    )
  on conflict (user_aircraft_id, ad_number) do nothing;

  -- Equipment-tagged match -- independent of airframe, same as
  -- send-ad-alerts.mjs's own second pass.
  insert into user_ad_notifications (user_id, user_aircraft_id, ad_number, matched_via)
  select v_user_id, p_user_aircraft_id, apm.ad_number, 'equipment'
  from user_aircraft_equipment uae
  join ad_part_mentions apm on apm.part_id = uae.part_id
  where uae.user_aircraft_id = p_user_aircraft_id
  on conflict (user_aircraft_id, ad_number) do nothing;

  select count(*) into v_after from user_ad_notifications where user_aircraft_id = p_user_aircraft_id;
  return v_after - v_before;
end;
$$;

grant execute on function public.backfill_aircraft_ad_notifications(uuid) to authenticated;
