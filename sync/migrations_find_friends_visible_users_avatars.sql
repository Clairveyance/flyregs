-- RC real duel test batch, bug #5 ("Ready Room / duel opponent-list
-- avatars show placeholder circles instead of the opponent's real
-- photo/avatar"): the main opponent picker (get_challengeable_users),
-- Ready Room's 3 leaderboards, and Duel history/pending list
-- (get_my_challenges) all already got real avatar_url/avatar_preset
-- wired in earlier (fc01281, 541786c) -- but Find Friends' own "OR BROWSE
-- PEOPLE" list (getVisibleUsers/get_visible_users, reachable from BOTH
-- Ready Room's header icon AND the Duels New Duel opponent picker's
-- findFriends sub-step) was missed: it only ever returned user_id +
-- display_label, so FindFriendsSheet.tsx always rendered a plain generic
-- person-icon circle for every row, real photo or not. Same privacy
-- shape as the leaderboard RPCs already approved for this (gated on
-- leaderboard_opt_in = true, the same opt-in that already exposes the
-- Callsign) -- no new privacy boundary, just the 2 fields those siblings
-- already expose.
--
-- Widening a zero-arg RETURNS TABLE shape errors ("cannot change return
-- type of existing function") under a bare CREATE OR REPLACE -- same gotcha
-- get_my_challenges() hit widening its own shape earlier -- so the old
-- 2-column signature must be dropped first, not just replaced.
drop function if exists public.get_visible_users();
create or replace function public.get_visible_users()
returns table(user_id uuid, display_label text, avatar_url text, avatar_preset text)
language sql
stable security definer
as $function$
  select u.id as user_id, cr.callsign::text as display_label,
    u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'avatar_preset'
  from user_streaks us
  join auth.users u on u.id = us.user_id
  join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true and u.id != auth.uid()
  order by 2;
$function$;
