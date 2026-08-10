-- Fix: get_ready_room_leaderboard / get_duels_leaderboard / get_mastery_leaderboard
-- filtered only on user_streaks.leaderboard_opt_in = true, with no server-side
-- check that the opted-in user actually currently holds Pro (or above).
-- account.tsx's own opt-in toggle correctly gates on isPro client-side, but a
-- Free-tier account could set leaderboard_opt_in=true directly via a plain
-- REST upsert on user_streaks (ownership-only RLS, no tier check there either)
-- and appear on all 3 leaderboards for free.
--
-- Found+live-proven via the 2026-08-10 full-app tier-gate audit (a disposable
-- Free-tier account opted itself in via its own JWT and appeared on the
-- Ready Room leaderboard).
--
-- Lower severity than the folder/RefPack fixes in this same batch -- no paid
-- CONTENT is exposed, a free user only surfaces their own already-in-app
-- stats -- but it's a real monetization-integrity gap matching this
-- project's own "cap/gate at read time, not just write time" lesson, so
-- fixed alongside the others while the same class of issue is fresh.
--
-- has_pro_access() matches the tier already used for the client-side gate
-- (account.tsx: `if (v && !isPro)`) and for leaderboard-eligible reminder
-- pushes elsewhere in the app -- Premium inherits Pro, so this doesn't
-- exclude Premium users.

CREATE OR REPLACE FUNCTION public.get_ready_room_leaderboard(p_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, display_label text, weekly_reviews bigint, weekly_correct bigint, current_streak integer, is_me boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
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
