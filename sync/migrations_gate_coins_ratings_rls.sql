-- "Show my stats" now actually hides your ratings and coins.
--
-- FOUND 2026-09-05, in the whole-app sweep, and PROVEN LIVE before writing
-- this: a brand-new FREE disposable account, holding nothing but the public
-- app key, ran
--
--     GET /rest/v1/user_profile_ratings?select=user_id,rating_code
--     GET /rest/v1/user_coins?select=user_id,coin_code
--
-- and got 200 with every user's rows -- RC's full rating list (COMM, ASEL,
-- AMEL, IR) among them. Both tables carried
--
--     user_coins_read_all           USING (true)  TO authenticated
--     user_profile_ratings_read_all USING (true)  TO authenticated
--
-- This is the THIRD appearance of one bug: a correct client gate over a
-- permissive table. user_duel_stats was the first (see
-- migrations_gate_user_duel_stats_rls.sql, fixed 2026-09-03 -- the same
-- probe returns ZERO rows for it now, which is what proves the shape below
-- works). The second was the avatars/aircraft-images bucket.
--
-- It matters more than it looks, because these are exactly the three fields
-- the "Show my stats" toggle names. profile/[userId].tsx even documents the
-- gap in a comment -- "user_coins/user_profile_ratings' RLS policies are
-- technically public-readable already (a pre-existing permissiveness this
-- screen doesn't rely on)" -- and honours the toggle client-side anyway. A
-- client gate protects nobody: the data was one HTTP request away for anyone
-- who could sign up, while the app told the user it was private.
--
-- THE RULE BELOW mirrors user_streaks_public_stats_read, which is the policy
-- that already governs this exact toggle:
--   * your own rows, always;
--   * someone else's, only while THEY have stats_visible = true.
--
-- A user with no user_streaks row at all counts as visible, matching
-- getStatsVisible()'s documented default (RC, 2026-09-04: "be seen in the
-- app, so default is on and they can turn off anytime"). Doing otherwise
-- would hide every new user's profile until something happened to create
-- their streaks row -- a silent regression dressed as a security fix.
--
-- Deliberately NOT copied from user_duel_stats: that policy also requires the
-- VIEWER to hold Premium, because duel records are a Premium feature. Ratings
-- and coins are shown on a profile any Plus user can open, so adding a
-- Premium requirement here would break a working screen for paying Plus and
-- Pro users. Same shape, correct gate.

begin;

-- A SECURITY DEFINER helper, NOT an inline sub-select on user_streaks.
--
-- The first version of this migration inlined
--   `... or not exists (select 1 from user_streaks us where us.user_id = X)`
-- to honour the "default is on" rule, and it did not work -- the live test
-- still returned the hidden user's rows. The reason is worth writing down,
-- because it is the SQL version of the exact `?? true` bug this whole change
-- is fixing:
--
--   A policy's sub-select is ITSELF subject to the referenced table's RLS.
--   user_streaks_public_stats_read is USING (stats_visible = true), so a
--   viewer cannot see a hidden user's streaks row AT ALL. From inside the
--   policy, "hidden" and "no row" are therefore indistinguishable -- and
--   `not exists` read that as "no row", i.e. the default, i.e. VISIBLE.
--   The clause meant to preserve the default for new users instead granted
--   access to precisely the people who had opted out.
--
-- (user_duel_stats_read_visible avoids this by accident: it has no default
-- clause, so an invisible row fails CLOSED. Copying its shape without
-- understanding that would have hidden every new user's profile instead.)
--
-- A SECURITY DEFINER function reads user_streaks with RLS bypassed, so it can
-- tell the two apart, and answers the one question the policies need.
create or replace function public.stats_visible_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select us.stats_visible from user_streaks us where us.user_id = p_user_id),
    -- No row at all: the documented default is ON (RC, 2026-09-04: "be seen
    -- in the app, so default is on and they can turn off anytime"). Hiding
    -- every user who has not yet had a streaks row created would be a silent
    -- regression dressed up as a security fix.
    true
  );
$$;

revoke all on function public.stats_visible_for(uuid) from public, anon;
grant execute on function public.stats_visible_for(uuid) to authenticated;

drop policy if exists user_coins_read_all on public.user_coins;
drop policy if exists user_coins_read_visible on public.user_coins;
create policy user_coins_read_visible on public.user_coins
  for select to authenticated
  using (user_id = auth.uid() or stats_visible_for(user_id));

drop policy if exists user_profile_ratings_read_all on public.user_profile_ratings;
drop policy if exists user_profile_ratings_read_visible on public.user_profile_ratings;
create policy user_profile_ratings_read_visible on public.user_profile_ratings
  for select to authenticated
  using (user_id = auth.uid() or stats_visible_for(user_id));

commit;
