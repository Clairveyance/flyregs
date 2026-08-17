-- Real bug, caught by tonight's QA sweep agent, live-reproduced: get_duel_stats
-- has taken a p_user_id parameter since 2026-08-14 (migrations_fix_duels_pii_leak.sql,
-- a real fix for a real enumeration leak) but the function body never actually
-- used it -- v_uid was hardcoded to auth.uid() regardless of what was passed.
-- That was harmless at the time because (per that migration's own justification)
-- nothing in the shipped app called it with an argument. That stopped being true
-- once profile/[userId].tsx was wired up to call getDuelStats(userId) for
-- someone ELSE's profile -- since then, every profile view of another user has
-- shown the VIEWER's own duel record, mislabeled as the profile subject's.
-- Confirmed live: get_duel_stats({p_user_id: B's uid}) called as A returned
-- A's own stats, byte-identical to calling it with no argument at all.
--
-- Restoring naive p_user_id support would re-open the original 2026-08-14 leak
-- (any signed-in user could pull any other user's win/loss record with zero
-- relationship check). Fixed instead with the same visibility gate
-- get_profile_avatar already uses for the exact same profile screen: self, OR
-- opted into Show Me (covers the Ready Room Duels leaderboard tap-through --
-- you can't appear on that leaderboard without leaderboard_opt_in), OR a real,
-- specific duel relationship with the caller (covers the Duels-history avatar
-- tap-through -- a manually-Callsign-added opponent might not be opted into
-- the leaderboard at all, so that flag alone doesn't cover every duel
-- participant). An unrelated caller gets 0/0/0, same as an unrelated caller
-- already gets no avatar/preset -- not an error, just nothing real to show.
create or replace function public.get_duel_stats(p_user_id uuid default null)
returns table(wins integer, losses integer, ties integer)
language plpgsql
security definer
as $function$
declare
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_visible boolean;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  if v_target = auth.uid() then
    v_visible := true;
  else
    select
      exists (select 1 from user_streaks us where us.user_id = v_target and us.leaderboard_opt_in = true)
      or exists (
        select 1
        from challenge_participants cp1
        join challenge_participants cp2 on cp2.challenge_id = cp1.challenge_id
        where cp1.user_id = auth.uid() and cp2.user_id = v_target
      )
    into v_visible;
  end if;

  if not v_visible then
    return query select 0, 0, 0;
    return;
  end if;

  return query
  select coalesce(s.wins,0), coalesce(s.losses,0), coalesce(s.ties,0)
  from (select 1) as dummy
  left join user_duel_stats s on s.user_id = v_target;
end;
$function$;
