-- Stop deriving public display names from email addresses (2026-08-31)
--
-- gotcha_leaderboard_email_exposure replaced split_part(u.email, '@', 1) with
-- 'Pilot' in the 3 leaderboard RPCs, and its own note said to check every other
-- public-display-name RPC. That sweep never happened. A corpus-wide scan of
-- pg_get_functiondef found the pattern still live in TWELVE more functions,
-- across both the duels and the sharing subsystems:
--
--   get_challengeable_users, get_my_challenges, get_challenge_results,
--   get_challenge_standings, get_duel_push_target,
--   get_folder_collaborators, get_shared_folder_owners,
--   get_my_pending_folder_invites, get_collaboration_invite_push_target,
--   get_aircraft_collaborators, get_my_shared_aircraft,
--   get_my_pending_aircraft_invites
--
-- get_challengeable_users is the sharpest: it lists EVERY opted-in Premium user
-- to every other Premium user in the opponent picker. This is exposable today,
-- not latent -- only 2 of 7 Premium users have a callsign, and at least one
-- opted-in user has neither a callsign nor a display_name, so their email local
-- part is what the picker renders.
--
-- The fallback chain is unchanged apart from its last link:
--   coalesce(callsign, raw_user_meta_data->>'display_name', 'Pilot')
-- so anyone who has set a callsign or display name is unaffected; only the
-- email leak is replaced.
--
-- Every body below was taken VERBATIM from live pg_get_functiondef with a
-- single literal substitution, and each was checked to have an unchanged line
-- count -- no hand-retyping, nothing else altered. Functions with overloads or
-- differing whitespace were skipped rather than guessed at (none were).

begin;

CREATE OR REPLACE FUNCTION public.get_aircraft_collaborators(p_aircraft_id uuid)
 RETURNS TABLE(out_user_id uuid, out_display_label text, out_role text, out_joined_at timestamp with time zone, out_last_viewed_at timestamp with time zone, out_accepted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
    select ac.user_id, coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      ac.role, ac.joined_at, ac.last_viewed_at, (ac.accepted_at is not null)
    from aircraft_collaborators ac
    join auth.users u on u.id = ac.user_id
    left join callsign_registry cr on cr.user_id = ac.user_id
    where ac.aircraft_id = p_aircraft_id and ac.left_at is null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_challenge_results(p_challenge_id uuid)
 RETURNS TABLE(sort_order integer, item_type text, item_id text, term text, definition text, answers jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_completed boolean;
begin
  if not exists (select 1 from challenge_participants cp where cp.challenge_id = p_challenge_id and cp.user_id = auth.uid()) then
    raise exception 'Challenge not found';
  end if;

  select c.status = 'completed' into v_completed from challenges c where c.id = p_challenge_id;
  v_completed := coalesce(v_completed, false);

  return query
  select
    cq.sort_order, cq.item_type, cq.item_id,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'dictionary' then (select d.term from dictionary_terms d where d.slug = cq.item_id)
      else cq.item_id
    end,
    case cq.item_type
      when 'pcg' then (select pt.definition from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'far' then (select f.title from far_sections f where f.section_number = cq.item_id)
      when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
      when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
      when 'cfr49' then (select f5.title from cfr49_sections f5 where f5.section_number = cq.item_id)
      when 'dictionary' then (
        select case when public.has_pro_access() then d.senses->0->>'definition' else null end
        from dictionary_terms d where d.slug = cq.item_id
      )
    end,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', cp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot'),
        'isMe', cp.user_id = auth.uid(),
        'isForfeited', cp.status = 'forfeited',
        'answerText', case when v_completed or cp.user_id = auth.uid() then ca.answer_text else null end,
        'isCorrect',  case when v_completed or cp.user_id = auth.uid() then ca.is_correct else null end,
        'timeMs',     case when v_completed or cp.user_id = auth.uid() then ca.time_ms else null end
      ) order by cp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants cp
      join auth.users u on u.id = cp.user_id
      left join callsign_registry cr on cr.user_id = cp.user_id
      left join challenge_answers ca on ca.challenge_question_id = cq.id and ca.user_id = cp.user_id
      where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
    )
  from challenge_questions cq
  where cq.challenge_id = p_challenge_id
    and (v_completed or exists (
      select 1 from challenge_answers ca2
      where ca2.challenge_question_id = cq.id and ca2.user_id = auth.uid()
    ))
  order by cq.sort_order;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_challenge_standings(p_challenge_id uuid)
 RETURNS TABLE(user_id uuid, label text, is_me boolean, correct_count integer, tiebreak_ms integer, final_rank integer, tie_group_size integer, is_forfeited boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare
  v_completed boolean;
begin
  if not exists (select 1 from challenge_participants cp
                 where cp.challenge_id = p_challenge_id and cp.user_id = auth.uid()) then
    raise exception 'Challenge not found';
  end if;

  select c.status = 'completed' into v_completed from challenges c where c.id = p_challenge_id;
  v_completed := coalesce(v_completed, false);

  return query
  with scored_participants as (
    select cp.user_id, cp.status from challenge_participants cp
    where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
  ),
  correct_counts as (
    select sp.user_id, sp.status,
      (select count(*)::int from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
         where cq.challenge_id = p_challenge_id and ca.user_id = sp.user_id and ca.is_correct) as correct_count
    from scored_participants sp
  ),
  qualifying_questions as (
    select cc1.user_id, cq.id as question_id
    from correct_counts cc1
    cross join challenge_questions cq
    where cq.challenge_id = p_challenge_id
    and not exists (
      select 1 from correct_counts cc2
      where cc2.correct_count = cc1.correct_count and cc2.status = cc1.status
      and not exists (
        select 1 from challenge_answers ca
        where ca.challenge_question_id = cq.id and ca.user_id = cc2.user_id and ca.is_correct
      )
    )
  ),
  tiebreak_times as (
    select qq.user_id, coalesce(sum(ca.time_ms), 0)::int as tiebreak_ms
    from qualifying_questions qq
    left join challenge_answers ca on ca.challenge_question_id = qq.question_id and ca.user_id = qq.user_id
    group by qq.user_id
  ),
  ranked as (
    select cc.user_id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot') as label,
      cc.user_id = auth.uid() as is_me,
      cc.correct_count,
      coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (
        order by (case when cc.status = 'forfeited' then 1 else 0 end),
                 cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc
      )::int as final_rank,
      count(*) over (
        partition by (case when cc.status = 'forfeited' then 1 else 0 end), cc.correct_count, coalesce(tt.tiebreak_ms, 0)
      )::int as tie_group_size,
      cc.status = 'forfeited' as is_forfeited
    from correct_counts cc
    join auth.users u on u.id = cc.user_id
    left join callsign_registry cr on cr.user_id = cc.user_id
    left join tiebreak_times tt on tt.user_id = cc.user_id
  )
  select r.user_id, r.label, r.is_me, r.correct_count, r.tiebreak_ms, r.final_rank, r.tie_group_size, r.is_forfeited
  from ranked r
  where v_completed or r.is_me
  order by r.final_rank, r.label;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_challengeable_users()
 RETURNS TABLE(user_id uuid, display_label text, avatar_url text, avatar_preset text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  return query
  select
    u.id,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
    u.raw_user_meta_data->>'avatar_url',
    u.raw_user_meta_data->>'avatar_preset'
  from user_streaks us
  join auth.users u on u.id = us.user_id
  left join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true
    and u.id != auth.uid()
    and exists (select 1 from user_entitlements ue2 where ue2.user_id = u.id and ue2.is_premium = true)
  order by display_label;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_collaboration_invite_push_target(p_target_user_id uuid, p_resource_type text, p_resource_label text, p_token text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_verified boolean := false;
begin
  if p_resource_type = 'aircraft' then
    select exists(
      select 1 from aircraft_collaborators ac
      where ac.owner_id = v_actor_id
        and ac.user_id = p_target_user_id
        and ac.invite_token = p_token
        and ac.accepted_at is null
    ) into v_verified;
  else
    select exists(
      select 1 from folder_collaborators fc
      where fc.owner_id = v_actor_id
        and fc.user_id = p_target_user_id
        and fc.invite_token = p_token
        and fc.accepted_at is null
    ) into v_verified;
  end if;

  if not v_verified then
    raise exception 'No matching pending invite found';
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_resource_type when 'aircraft' then 'Aircraft invite' else 'Folder invite' end,
    case p_resource_type
      when 'aircraft' then v_actor_label || ' invited you to ' || p_resource_label
      else v_actor_label || ' invited you to the folder "' || p_resource_label || '"'
    end
  from push_tokens pt
  where pt.user_id = p_target_user_id
    and pt.user_id != v_actor_id
    and pt.expo_push_token is not null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_total_questions int;
begin
  if not exists (
    select 1 from challenge_participants cp0
    where cp0.challenge_id = p_challenge_id and cp0.user_id = v_actor_id
  ) then
    raise exception 'Not a participant in this challenge';
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  select count(*) into v_total_questions from challenge_questions where challenge_id = p_challenge_id;

  return query
  select pt.expo_push_token,
    case p_event
      when 'invited' then 'Duel Invite'
      when 'accepted' then 'Duel Accepted'
      when 'answered' then 'Your Move'
      when 'completed' then 'Duel Finished'
      else 'Duel Update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' is challenging you to a duel. Accept or decline?'
      when 'accepted' then v_actor_label || ' accepted your duel — your move'
      when 'answered' then v_actor_label || ' finished their answers — your move'
      when 'completed' then 'See how you did against ' || v_actor_label
      else 'Check your Duel with ' || v_actor_label
    end
  from challenge_participants cp
  join push_tokens pt on pt.user_id = cp.user_id
  where cp.challenge_id = p_challenge_id
    and cp.user_id != v_actor_id
    and pt.duel_notifications_enabled = true
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
      or (
        p_event = 'answered' and cp.status = 'active'
        and (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
             where cq.challenge_id = p_challenge_id and ca.user_id = cp.user_id) < v_total_questions
      )
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_folder_collaborators(p_folder_id text)
 RETURNS TABLE(out_user_id uuid, out_display_label text, out_joined_at timestamp with time zone, out_left_at timestamp with time zone, out_last_viewed_at timestamp with time zone, out_collab_mode text, out_accepted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from synced_folders where id = p_folder_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
    select
      fc.user_id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at,
      fc.collab_mode,
      (fc.accepted_at is not null)
    from folder_collaborators fc
    join auth.users u on u.id = fc.user_id
    left join callsign_registry cr on cr.user_id = fc.user_id
    where fc.folder_id = p_folder_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_challenges()
 RETURNS TABLE(challenge_id uuid, am_challenger boolean, status text, my_status text, question_count integer, my_answered_count integer, created_at timestamp with time zone, item_types text[], levels text[], category_classes text[], ratings text[], others jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if not exists (select 1 from user_entitlements e where e.user_id = auth.uid() and e.is_premium = true) then
    return;
  end if;
  return query
  select
    c.id,
    c.challenger_id = auth.uid(),
    c.status,
    mycp.status,
    c.question_count,
    (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
       where cq.challenge_id = c.id and ca.user_id = auth.uid())::int,
    c.created_at,
    c.item_types,
    c.levels,
    c.category_classes,
    c.ratings,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', ocp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot'),
        'status', ocp.status,
        'answeredCount', (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = ocp.user_id),
        'avatarUrl', u.raw_user_meta_data->>'avatar_url',
        'avatarPreset', u.raw_user_meta_data->>'avatar_preset'
      ) order by ocp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants ocp
      join auth.users u on u.id = ocp.user_id
      left join callsign_registry cr on cr.user_id = ocp.user_id
      where ocp.challenge_id = c.id and ocp.user_id != auth.uid()
    )
  from challenges c
  join challenge_participants mycp on mycp.challenge_id = c.id and mycp.user_id = auth.uid() and mycp.hidden_at is null
  order by c.created_at desc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_pending_aircraft_invites()
 RETURNS TABLE(out_aircraft_id uuid, out_nickname text, out_make text, out_model text, out_inviter_label text, out_invited_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    ac.aircraft_id,
    ua.nickname,
    ua.make,
    ua.model,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
    ac.joined_at
  from aircraft_collaborators ac
  join user_aircraft ua on ua.id = ac.aircraft_id
  join auth.users u on u.id = ac.owner_id
  left join callsign_registry cr on cr.user_id = ac.owner_id
  where ac.user_id = auth.uid()
    and ac.left_at is null
    and ac.accepted_at is null
    and ac.invite_token is not null;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_pending_folder_invites()
 RETURNS TABLE(out_folder_id text, out_folder_name text, out_inviter_label text, out_invited_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    fc.folder_id,
    sf.name::text,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
    fc.joined_at
  from folder_collaborators fc
  join synced_folders sf on sf.id = fc.folder_id and sf.deleted = false
  join auth.users u on u.id = fc.owner_id
  left join callsign_registry cr on cr.user_id = fc.owner_id
  where fc.user_id = auth.uid()
    and fc.left_at is null
    and fc.accepted_at is null
    and fc.invite_token is not null;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_shared_aircraft()
 RETURNS TABLE(out_aircraft_id uuid, out_make text, out_model text, out_nickname text, out_type_designator text, out_year integer, out_role text, out_owner_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
    select ua.id, ua.make, ua.model, ua.nickname, ua.type_designator, ua.year, ac.role,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text
    from aircraft_collaborators ac
    join user_aircraft ua on ua.id = ac.aircraft_id
    join auth.users u on u.id = ac.owner_id
    left join callsign_registry cr on cr.user_id = ac.owner_id
    where ac.user_id = auth.uid() and ac.left_at is null and ac.accepted_at is not null
      and public.has_aircraft_access(ac.aircraft_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_shared_folder_owners(p_folder_ids text[])
 RETURNS TABLE(out_folder_id text, out_owner_avatar_url text, out_owner_avatar_preset text, out_owner_display_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
    SELECT
      sf.id,
      (u.raw_user_meta_data->>'avatar_url')::text,
      (u.raw_user_meta_data->>'avatar_preset')::text,
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text
    FROM synced_folders sf
    JOIN auth.users u ON u.id = sf.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = sf.user_id
    WHERE sf.id = ANY(p_folder_ids)
      AND public.has_folder_access(sf.id);
END;
$function$
;
commit;

-- VERIFY AFTER APPLYING:
--   select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--     where n.nspname='public' and pg_get_functiondef(p.oid) like '%split_part(u.email%';
--   -> must be 0
--   python3 scripts/duel_e2e_test.py full        -> all pass
--   python3 scripts/folders_e2e_test.py          -> all pass
--   python3 scripts/aircraft_sharing_e2e_test.py -> all pass
