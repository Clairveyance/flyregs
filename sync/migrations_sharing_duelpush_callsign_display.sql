-- Data-accuracy audit (task #326), same corpus-wide sweep that found and
-- fixed the 3 Ready Room leaderboard RPCs (see
-- migrations_leaderboard_callsign_display.sql) also turned up 5 MORE
-- functions with the identical anti-pattern -- a plain
-- `coalesce(raw_user_meta_data->>'display_name', split_part(email,'@',1))`
-- with no callsign_registry join at all:
--   - get_shared_folder_owners / get_folder_collaborators: a shared
--     folder's owner and its collaborators never saw each other's real
--     chosen Callsign -- fell back to a stale display_name or an email
--     prefix leaking to everyone they'd shared with.
--   - get_my_shared_aircraft / get_aircraft_collaborators: same leak, for
--     shared aircraft owners/collaborators.
--   - get_duel_push_target: the worst of the five -- this builds the
--     ACTUAL PUSH NOTIFICATION TEXT sent to a real device ("X challenged
--     you to a duel"), so the wrong-name bug wasn't just a UI cosmetic
--     issue, it was reaching users' lock screens.
-- All 5 fixed with the same `left join callsign_registry cr on
-- cr.user_id = ...` + callsign-first coalesce pattern already used by
-- get_challenge_standings and the Duels match RPCs (task #323). Verified
-- the resolved label for our test account (real Callsign "RC") directly
-- against callsign_registry; the underlying auth.users join logic is
-- otherwise unchanged in every function.
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
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text
    FROM synced_folders sf
    JOIN auth.users u ON u.id = sf.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = sf.user_id
    WHERE sf.id = ANY(p_folder_ids)
      AND sf.id IN (SELECT folder_id FROM folder_collaborators WHERE user_id = auth.uid());
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_folder_collaborators(p_folder_id text)
 RETURNS TABLE(out_user_id uuid, out_display_label text, out_joined_at timestamp with time zone, out_left_at timestamp with time zone, out_last_viewed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM synced_folders WHERE id = p_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT
      fc.user_id,
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at
    FROM folder_collaborators fc
    JOIN auth.users u ON u.id = fc.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = fc.user_id
    WHERE fc.folder_id = p_folder_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_shared_aircraft()
 RETURNS TABLE(out_aircraft_id uuid, out_make text, out_model text, out_nickname text, out_type_designator text, out_year integer, out_role text, out_owner_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
    select ua.id, ua.make, ua.model, ua.nickname, ua.type_designator, ua.year, ac.role,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text
    from aircraft_collaborators ac
    join user_aircraft ua on ua.id = ac.aircraft_id
    join auth.users u on u.id = ac.owner_id
    left join callsign_registry cr on cr.user_id = ac.owner_id
    where ac.user_id = auth.uid() and ac.left_at is null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_aircraft_collaborators(p_aircraft_id uuid)
 RETURNS TABLE(out_user_id uuid, out_display_label text, out_role text, out_joined_at timestamp with time zone, out_last_viewed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
    select ac.user_id, coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      ac.role, ac.joined_at, ac.last_viewed_at
    from aircraft_collaborators ac
    join auth.users u on u.id = ac.user_id
    left join callsign_registry cr on cr.user_id = ac.user_id
    where ac.aircraft_id = p_aircraft_id and ac.left_at is null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
begin
  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_event
      when 'invited' then 'Duel invite'
      when 'accepted' then 'Duel accepted'
      when 'completed' then 'Duel finished'
      else 'Duel update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' challenged you to a duel'
      when 'accepted' then v_actor_label || ' accepted your duel — your move'
      when 'completed' then 'See how you did against ' || v_actor_label
      else 'Check your Duel with ' || v_actor_label
    end
  from challenge_participants cp
  join push_tokens pt on pt.user_id = cp.user_id
  where cp.challenge_id = p_challenge_id
    and cp.user_id != v_actor_id
    and pt.enabled = true
    and pt.duel_notifications_enabled = true
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
    )
  limit 1;
end;
$function$;
