-- Parts: editor collaborators, and an auth guard defeated by NULL (2026-09-01)
--
-- Three findings from an end-to-end sweep of the Aircraft Equipment feature.
-- Both function bodies below were taken VERBATIM from live pg_get_functiondef
-- and diffed line by line: the ONLY lines removed are the two guard lines
-- being replaced. Not hand-retyped.
--
-- 1. An editor collaborator could tag a part, but its ADs never appeared.
--    RLS on user_aircraft_equipment lets an editor insert (that is deliberate,
--    and faq.tsx promises it verbatim: "Editor (can also add equipment and
--    reminders, and mark ADs complied)"), but backfill_aircraft_ad_notifications
--    was owner-only. It returned 0, the client's `.then(count => ...)` treats 0
--    as "nothing to refresh", and nothing ever errored -- a silent no-op. It
--    also never self-corrects: send-ad-alerts.mjs only processes the ADs touched
--    by that sync run, so the part's HISTORICAL ADs are never picked up later.
--    Proof this is an oversight, not a design decision: the delete side,
--    prune_orphaned_equipment_ad_notifications, already accepts editors. An
--    editor could remove AD matches but not create them.
--
-- 2. An editor correcting an aircraft's make/model never re-derived its ADs.
--    EditAircraftModal is opened by canEdit (owner OR editor) and calls
--    resync_aircraft_ad_notifications on a real identity change -- the exact
--    mechanism migrations_aircraft_ad_resync.sql exists to guarantee. For an
--    editor it silently returned {0,0}, so a 172S corrected to a PA-28-181 kept
--    all of its Cessna ADs and showed none of the Piper's, forever.
--
-- 3. backfill_aircraft_ad_notifications' guard was defeated by a NULL
--    auth.uid(). `v_user_id <> auth.uid()` is NULL when unauthenticated, and
--    plpgsql does not take an IF branch on NULL -- so the guard fell through
--    entirely. Verified in-DB: `select (gen_random_uuid() is null or
--    gen_random_uuid() <> null::uuid)` returns NULL, not true. And it was
--    reachable without a session: this was the only one of the three fleet RPCs
--    still carrying a PUBLIC execute grant. `is distinct from` fixes the logic;
--    the revoke below removes the anonymous reach. Impact was bounded (an
--    attacker needs a valid aircraft UUID, and the payload is a forced backfill
--    plus an integer count) but it is a real auth-guard defect.
--
-- Rows are still written with user_id = the OWNER, which is the shape
-- gotcha_aircraft_share_reminder_visibility documents as correct for this
-- table -- an editor's work stays visible to the owner.

begin;

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
$function$
;

CREATE OR REPLACE FUNCTION public.resync_aircraft_ad_notifications(p_user_aircraft_id uuid)
 RETURNS TABLE(out_removed integer, out_added integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_before text[];
  v_after  text[];
  v_saved  jsonb;
begin
  out_removed := 0;
  out_added := 0;

  if not exists (
    select 1 from user_aircraft where id = p_user_aircraft_id and user_id = auth.uid()
  -- an editor correcting make/model must re-derive ADs too: the edit modal
  -- is opened by canEdit (owner OR editor), so for an editor this silently
  -- returned {0,0} and the aircraft kept the ADs of its OLD identity.
  ) and not public.has_aircraft_access(p_user_aircraft_id, true) then
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
$function$
;

-- 3b. Remove anonymous reach on all three fleet RPCs. `anon` has no legitimate
-- reason to execute any of them; the other two are safe today only because
-- their `not exists (... = auth.uid())` guards happen to evaluate true when
-- auth.uid() is NULL.
revoke execute on function public.backfill_aircraft_ad_notifications(uuid) from public, anon;
revoke execute on function public.resync_aircraft_ad_notifications(uuid) from anon;
revoke execute on function public.prune_orphaned_equipment_ad_notifications(uuid) from anon;
grant  execute on function public.backfill_aircraft_ad_notifications(uuid) to authenticated;

commit;

-- VERIFY AFTER APPLYING:
--   aircraft_e2e_test.py, aircraft_sharing_e2e_test.py,
--   aircraft_collaborator_role_change_test.py, fleet_sweep_regression_test.py
--   all still pass; anon can no longer execute the three RPCs.
