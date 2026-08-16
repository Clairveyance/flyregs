-- RC: "don't call them 'pilots' - not all users are pilots." The 3 live
-- leaderboard RPCs (get_ready_room_leaderboard, get_duels_leaderboard,
-- get_mastery_leaderboard) fall back to the literal string 'Pilot' as a
-- display name for any opted-in user who hasn't set a Callsign or a
-- raw_user_meta_data display_name -- not a copy string anywhere, but baked
-- into the COALESCE inside each function (see
-- sync/migrations_fix_leaderboard_email_exposure.sql, which introduced it).
-- Same fix as account.tsx's client-side 'Pilot' fallback and
-- profile/[userId].tsx's -- swapped to the generic 'Member', consistent
-- with the "Show Me"/"opted-in members" copy on Account. Signatures
-- unchanged, so a plain CREATE OR REPLACE is safe.

create or replace function public.get_ready_room_leaderboard(p_limit integer DEFAULT 20)
 returns table(user_id uuid, display_label text, weekly_reviews bigint, weekly_correct bigint, current_streak integer, is_me boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT public.has_pro_access() THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT
      u.id,
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
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

create or replace function public.get_duels_leaderboard(p_limit integer DEFAULT 50)
 returns table(user_id uuid, display_label text, wins integer, losses integer, ties integer, is_me boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.has_pro_access() then
    return;
  end if;
  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
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

create or replace function public.get_mastery_leaderboard(p_limit integer DEFAULT 50)
 returns table(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
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
