-- ============================================================================
-- Duels + Mastery global leaderboards -- 2026-08-02
--
-- RC: "can the RR have a 'global' leaderboard? something that takes the
-- scores from every user on the platform, and ranks you across every
-- person... i think, duels ranking, and probably your total Overall
-- Mastery %. plus the nametag. all the things to really brag about."
--
-- Ready Room's existing leaderboard (get_ready_room_leaderboard, weekly
-- Study Mode review count) was ALREADY global + opt-in (user_streaks.
-- leaderboard_opt_in, off by default) and already tapped through to the
-- real "nametag" (profile/[userId].tsx). These two new RPCs add the same
-- pattern for Duels (wins) and Overall Mastery (%), reusing the exact same
-- opt-in flag and row shape so ready-room.tsx can switch between tabs
-- against one consistent contract.
-- ============================================================================

-- Mirrors get_ready_room_leaderboard's own structure exactly (same
-- user_streaks.leaderboard_opt_in gate, same auth.users display-name
-- resolution, same is_me flag), ordered by wins instead of weekly reviews.
-- Requires at least one recorded duel so brand-new/inactive opted-in users
-- don't clutter the board with 0-0-0 rows -- same "having done something"
-- gate get_ready_room_leaderboard already applies to weekly reviews.
create or replace function public.get_duels_leaderboard(p_limit integer default 50)
returns table(user_id uuid, display_label text, wins integer, losses integer, ties integer, is_me boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
    select
      u.id,
      coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      coalesce(s.wins, 0),
      coalesce(s.losses, 0),
      coalesce(s.ties, 0),
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join user_duel_stats s on s.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and coalesce(s.wins, 0) + coalesce(s.losses, 0) + coalesce(s.ties, 0) > 0
    order by coalesce(s.wins, 0) desc, coalesce(s.losses, 0) asc
    limit p_limit;
end;
$function$;

-- Same mastered/seen/total_available/pct shape and formula as
-- get_study_mastery(p_item_type := null) (the "Overall Mastery" ring on
-- study.tsx), but that function is hardcoded to auth.uid() and can only
-- ever answer for the calling user -- this computes the same thing for
-- every opted-in user in one grouped query instead. total_available is a
-- corpus-wide constant (not user-specific), so it's computed once via a
-- local variable rather than once per row.
create or replace function public.get_mastery_leaderboard(p_limit integer default 50)
returns table(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      count(sp.*) filter (where sp.correct_streak >= 3)::int as mastered,
      count(sp.*)::int as seen,
      v_total as total_available,
      case when v_total = 0 then 0
        else round(count(sp.*) filter (where sp.correct_streak >= 3) * 100.0 / v_total)::int
      end as pct,
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join study_progress sp on sp.user_id = us.user_id
    where us.leaderboard_opt_in = true
    group by u.id, u.raw_user_meta_data, u.email
    having count(sp.*) filter (where sp.correct_streak >= 3) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;

grant execute on function public.get_duels_leaderboard(integer) to anon, authenticated;
grant execute on function public.get_mastery_leaderboard(integer) to anon, authenticated;

-- profile/[userId].tsx's nametag page needs ONE specific user's mastery %
-- (not the whole leaderboard, which also excludes anyone below the
-- mastered>0 / opt-in bar) -- adds an optional p_user_id, same established
-- pattern as get_duel_stats(p_user_id uuid default null). Trailing
-- parameter with a default is backward compatible: get_study_mastery()'s
-- one existing caller (src/lib/study.ts, no params passed at all) is
-- unaffected.
create or replace function public.get_study_mastery(p_item_type text default null::text, p_user_id uuid default null::uuid)
returns table(mastered integer, seen integer, total_available integer, pct integer)
language sql
stable security definer
as $function$
  with target as (
    select coalesce(p_user_id, auth.uid()) as uid
  ),
  avail AS (
    SELECT (
      CASE WHEN p_item_type IS NULL OR p_item_type = 'pcg' THEN
        (SELECT count(*) FROM pcg_terms WHERE definition IS NOT NULL AND definition <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'far' THEN
        (SELECT count(*) FROM study_far_sections) ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'aim' THEN
        (SELECT count(*) FROM aim_paragraphs WHERE body_text IS NOT NULL AND body_text <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'ac' THEN
        (SELECT count(*) FROM advisory_circulars WHERE status = 'active' AND description IS NOT NULL AND description <> '' AND title IS NOT NULL AND title <> '') ELSE 0 END
    ) AS total
  )
  SELECT
    (SELECT count(*) FILTER (WHERE correct_streak >= 3) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS mastered,
    (SELECT count(*) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS seen,
    avail.total::int AS total_available,
    CASE WHEN avail.total = 0 THEN 0
      ELSE round((SELECT count(*) FILTER (WHERE correct_streak >= 3) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type)) * 100.0 / avail.total)::int
    END AS pct
  FROM avail;
$function$;

grant execute on function public.get_study_mastery(text, uuid) to anon, authenticated;
