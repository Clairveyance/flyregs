-- Bug: get_duels_leaderboard, get_mastery_leaderboard, get_ready_room_leaderboard all used
--   coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
-- as the publicly-displayed name on 3 leaderboards visible to every other opted-in user.
-- account.tsx's handleToggleLeaderboard only gates leaderboard visibility on Pro tier -- it
-- never checks whether the user has actually set a Callsign or display_name. So a Pro user
-- could opt in to a leaderboard before ever setting a Callsign, and their real email's
-- local-part (everything before the @) would be shown to every other viewer as their name.
--
-- Found 2026-08-09 via the same "does a disposable-account script actually exercise the
-- edge-case path" check that already found the has_aircraft_access pending-invite leak and
-- the get_fleet_hidden_count pending-invite bug this session -- there was no E2E coverage at
-- all for any of the 3 leaderboard RPCs, and none of them had a regression test for the
-- no-callsign-yet case.
--
-- Verified no real user was ever actually exposed: live query of
-- user_streaks/auth.users/callsign_registry WHERE leaderboard_opt_in = true returned only
-- Adriana (has both display_name and callsign "Adri", never hit the email fallback) and one
-- orphaned @flyregs.invalid test account (predates this session, zero activity, would never
-- pass any of the 3 HAVING clauses). Latent gap, not an active incident -- fixed proactively.
--
-- Fix: replace the split_part(email) fallback with a generic non-identifying literal.
-- The right long-term fix is also making account.tsx require a Callsign before allowing
-- leaderboard opt-in (tracked in PROJECT_NOTES/flyregs_pending.md) so a real display name is
-- always available -- this migration only closes the data-exposure hole in the 3 RPCs.

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
    group by u.id, u.raw_user_meta_data, u.email, cr.callsign
    having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;

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
    GROUP BY u.id, u.raw_user_meta_data, u.email, us.current_streak, cr.callsign
    HAVING count(sp.*) FILTER (WHERE sp.last_reviewed_at >= now() - interval '7 days') > 0
    ORDER BY weekly_reviews DESC
    LIMIT p_limit;
END;
$function$;
