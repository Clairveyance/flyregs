-- user_duel_stats RLS was USING (true) (2026-09-03)
--
-- get_duel_stats() implements a careful two-part gate: the CALLER must be
-- Premium ("Duels requires Premium"), and the TARGET must either have opted in
-- to the leaderboard or have actually duelled the caller -- otherwise it
-- deliberately returns 0,0,0 rather than the real record.
--
-- The table underneath it granted SELECT to every authenticated user with
-- USING (true), so a single
--     GET /rest/v1/user_duel_stats?select=user_id,wins,losses,ties
-- with the public anon key and any free account returned EVERY user's win/loss
-- record, bypassing both halves. Proven live with a disposable free account:
-- the RPC returned 400 "Duels requires Premium" while the raw table returned
-- 200 with every row. Anon is already blocked (401), so this is
-- authenticated-only -- but every account is one free signup away.
--
-- Same bug class as gotcha_tier_gate_client_side_only and
-- gotcha_rls_does_not_gate_columns: a correct RPC gate undone by a permissive
-- policy on the table beneath it.
--
-- The policy below mirrors get_duel_stats()'s own visibility logic exactly, so
-- the two can no longer disagree. Note the write policy (FOR ALL,
-- auth.uid() = user_id) is left untouched -- it is already correct, and
-- finalize_challenge_if_done writes through SECURITY DEFINER anyway.

begin;

drop policy if exists user_duel_stats_read_all on public.user_duel_stats;

create policy user_duel_stats_read_visible on public.user_duel_stats
  for select to authenticated
  using (
    -- your own record is always yours
    user_id = auth.uid()
    or (
      exists (select 1 from user_entitlements ue
               where ue.user_id = auth.uid() and ue.is_premium = true)
      and (
        exists (select 1 from user_streaks us
                 where us.user_id = user_duel_stats.user_id
                   and us.leaderboard_opt_in = true)
        or exists (select 1 from challenge_participants cp1
                     join challenge_participants cp2 on cp2.challenge_id = cp1.challenge_id
                    where cp1.user_id = auth.uid()
                      and cp2.user_id = user_duel_stats.user_id)
      )
    )
  );

commit;
