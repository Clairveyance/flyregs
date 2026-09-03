-- Fix: "permission denied for table user_streaks" on the Account toggles.
--
-- REPORTED BY A BETA TESTER 2026-09-02 (robinleabman@gmail.com, submission
-- 625c6e0f-ad78-43af-8bb6-a0dd4598e723, with a screenshot): toggling "Show Me"
-- in Account settings raises a hard red Error dialog reading
-- "permission denied for table user_streaks".
--
-- ROOT CAUSE. leaderboard.ts's setStatsVisible() and setLeaderboardOptIn()
-- both do a DIRECT client-side .upsert() on user_streaks. Verified live:
--   authenticated -> REFERENCES, SELECT, TRIGGER      (no INSERT, no UPDATE)
--   service_role  -> full
-- So the write is rejected at the GRANT layer, before RLS is even consulted.
-- The RLS policy user_streaks_own_rows (ALL, public) would have allowed it;
-- the table-level grant never did. BOTH toggles have therefore never worked
-- for anyone -- the tester simply hit "Show Me" first.
--
-- WHY NOT JUST GRANT INSERT/UPDATE. Because user_streaks also holds
-- current_streak, longest_streak and last_active_date -- real game state
-- behind the Ready Room leaderboard. Granting the client write access to the
-- table would let anyone forge their own streak, and a duels/study audit the
-- same day specifically confirmed that client-side score forgery is currently
-- NOT reachable precisely because these tables are SELECT-only. That property
-- is worth keeping.
--
-- So: a SECURITY DEFINER RPC that can only ever touch the two visibility
-- booleans, only for the caller's own row. Streak counters stay unwritable
-- from a client.
--
-- Nullable params so each toggle changes only its own flag; the other is left
-- exactly as it was. Every NOT NULL column on the table has a default except
-- user_id, so the insert branch is safe.

create or replace function public.set_streak_visibility(
  p_leaderboard_opt_in boolean default null,
  p_stats_visible boolean default null
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.user_streaks (user_id, leaderboard_opt_in, stats_visible, updated_at)
  values (
    auth.uid(),
    coalesce(p_leaderboard_opt_in, false),
    coalesce(p_stats_visible, false),
    now()
  )
  on conflict (user_id) do update set
    leaderboard_opt_in = coalesce(p_leaderboard_opt_in, public.user_streaks.leaderboard_opt_in),
    stats_visible      = coalesce(p_stats_visible,      public.user_streaks.stats_visible),
    updated_at         = now();
end;
$$;

revoke execute on function public.set_streak_visibility(boolean, boolean) from anon;
grant execute on function public.set_streak_visibility(boolean, boolean) to authenticated;

-- ROLLBACK: drop function public.set_streak_visibility(boolean, boolean);
