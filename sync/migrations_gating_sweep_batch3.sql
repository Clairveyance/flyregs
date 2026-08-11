-- Gating sweep 2026-08-11, batch 3.
--
-- Ready Room / leaderboard VIEW gate (Pro) -- all 3 leaderboard RPCs
-- correctly filter which LISTED users appear (has_pro_access(us.user_id)
-- on each row), but never checked whether the CALLER themselves is Pro.
-- Live-confirmed: a non-Pro account, and a fully anonymous caller with only
-- the bundled anon key, could both read real production leaderboard rows
-- (real display names, real win/loss/streak data) -- the only gate was the
-- client's own `if (!isPro)` blocking navigation to the screen.
CREATE OR REPLACE FUNCTION public.get_ready_room_leaderboard(p_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, display_label text, weekly_reviews bigint, weekly_correct bigint, current_streak integer, is_me boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_pro_access() THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT
      u.id,
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days')::bigint AS weekly_reviews,
      count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days' AND sp.total_correct > 0)::bigint AS weekly_correct,
      COALESCE(us.current_streak, 0),
      u.id = auth.uid()
    FROM user_streaks us
    JOIN auth.users u ON u.id = us.user_id
    LEFT JOIN study_progress sp ON sp.user_id = us.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = us.user_id
    WHERE us.leaderboard_opt_in = true
      AND public.has_pro_access(us.user_id)
    GROUP BY u.id, u.raw_user_meta_data, u.email, us.current_streak, cr.callsign
    HAVING count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days') > 0
    ORDER BY weekly_reviews DESC
    LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_duels_leaderboard(p_limit integer DEFAULT 50)
 RETURNS TABLE(user_id uuid, display_label text, wins integer, losses integer, ties integer, is_me boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.has_pro_access() then
    return;
  end if;
  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      coalesce(s.wins, 0),
      coalesce(s.losses, 0),
      coalesce(s.ties, 0),
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join user_duel_stats s on s.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and public.has_pro_access(us.user_id)
      and coalesce(s.wins, 0) + coalesce(s.losses, 0) + coalesce(s.ties, 0) > 0
    order by coalesce(s.wins, 0) desc, coalesce(s.losses, 0) asc
    limit p_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_mastery_leaderboard(p_limit integer DEFAULT 50)
 RETURNS TABLE(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total integer;
begin
  if not public.has_pro_access() then
    return;
  end if;

  select (
    (select count(*) from pcg_terms where definition is not null and definition <> '')
    + (select count(*) from study_far_sections)
    + (select count(*) from aim_paragraphs where body_text is not null and body_text <> '')
    + (select count(*) from advisory_circulars where status = 'active' and description is not null and description <> '' and title is not null and title <> '')
  ) into v_total;

  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      count(sp.*) filter (where sp.correct_streak >= 2)::int as mastered,
      count(sp.*)::int as seen,
      v_total as total_available,
      case when v_total = 0 then 0
        else round(count(sp.*) filter (where sp.correct_streak >= 2) * 100.0 / v_total)::int
      end as pct,
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join study_progress sp on sp.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and public.has_pro_access(us.user_id)
    group by u.id, u.raw_user_meta_data, u.email, cr.callsign
    having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;

-- Missed call sites (pattern: the same relationship-lapses-but-access-
-- persists shape Duels/Sharing were fixed for, just in 2 RPCs that fix
-- never touched). Both had their own inline membership check instead of
-- delegating through has_aircraft_access()/has_folder_access(), which are
-- the only functions that actually re-check live entitlement.
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
    where ac.user_id = auth.uid() and ac.left_at is null and ac.accepted_at is not null
      and public.has_aircraft_access(ac.aircraft_id);
end;
$function$;

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
      AND public.has_folder_access(sf.id);
END;
$function$;

-- synced_folder_items had NO trigger of its own at all -- a Free account
-- could INSERT directly with an arbitrary folder_id, no cap check, no
-- Plus check, unrelated to whether enforce_folder_cap() (which only fires
-- on synced_folders itself) had already run for that folder. Every insert
-- must belong to a folder the caller actually owns (and is still live
-- Plus for -- ownership alone doesn't mean much if they downgraded after
-- creating it, same "continuous, not just at creation" gap this session
-- already found for Duels/sharing) or collaborates on with write access,
-- which has_folder_access(..., true) already expresses for the latter.
CREATE OR REPLACE FUNCTION public.enforce_folder_item_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM synced_folders sf WHERE sf.id = NEW.folder_id AND sf.user_id = auth.uid() AND public.has_plus_access(sf.user_id))
    OR public.has_folder_access(NEW.folder_id, true)
  ) THEN
    RAISE EXCEPTION 'You do not have write access to this folder';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_folder_item_access ON public.synced_folder_items;
CREATE TRIGGER trg_enforce_folder_item_access
  BEFORE INSERT ON public.synced_folder_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_folder_item_access();

-- Duel Alerts push (Pro) -- courtesy push toggle had no server gate at
-- all; low severity (Accept itself stays correctly Premium-gated) but the
-- task's own brief named Pro as the intended tier for the push itself.
CREATE OR REPLACE FUNCTION public.enforce_duel_push_pro_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.duel_notifications_enabled AND NOT public.has_pro_access(NEW.user_id) THEN
    NEW.duel_notifications_enabled := false;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_duel_push_pro_gate ON public.push_tokens;
CREATE TRIGGER trg_enforce_duel_push_pro_gate
  BEFORE INSERT OR UPDATE ON public.push_tokens
  FOR EACH ROW EXECUTE FUNCTION public.enforce_duel_push_pro_gate();
