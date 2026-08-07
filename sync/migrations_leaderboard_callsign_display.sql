-- Data-accuracy audit (task #326) found that the Ready Room's 3 leaderboard
-- RPCs -- get_ready_room_leaderboard, get_duels_leaderboard,
-- get_mastery_leaderboard -- never got the callsign_registry join that
-- task #323 (see gotcha_duels_missing_callsign_display) already added to
-- Duels' own match-facing RPCs. All 3 still fell back straight from
-- raw_user_meta_data->>'display_name' to an email-prefix, meaning a user's
-- chosen Callsign never showed on the leaderboard itself -- and for anyone
-- who never set a display_name, their email prefix would leak publicly.
-- Fixed by adding `left join callsign_registry cr on cr.user_id = ...` and
-- putting cr.callsign first in the coalesce, matching the exact pattern
-- get_challenge_standings already uses. Live-verified: our test account
-- (real Callsign "RC") and a seeded account with no callsign set (falls
-- through to its email-prefix fallback, as intended) both resolve
-- correctly across all 3 functions.
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
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days')::bigint AS weekly_reviews,
      count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days' AND sp.total_correct > 0)::bigint AS weekly_correct,
      COALESCE(us.current_streak, 0),
      u.id = auth.uid()
    FROM user_streaks us
    JOIN auth.users u ON u.id = us.user_id
    LEFT JOIN study_progress sp ON sp.user_id = us.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = us.user_id
    WHERE us.leaderboard_opt_in = true
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
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      coalesce(s.wins, 0),
      coalesce(s.losses, 0),
      coalesce(s.ties, 0),
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join user_duel_stats s on s.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
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
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
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
    group by u.id, u.raw_user_meta_data, u.email, cr.callsign
    having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;
