-- RC: "if all 'visible' users show up in RR, then that should be another
-- way of searching/finding someone - so, along w/ 'search callsign' we
-- should have the ability to scroll the RR list for people."
--
-- Ready Room's 3 leaderboard tabs (Study/Duels/Mastery) each only show
-- opted-in (user_streaks.leaderboard_opt_in = true) users who ALSO have
-- real activity in that specific dimension -- someone who's opted in but
-- has zero study reviews, zero duels, and zero mastered terms doesn't
-- appear on ANY of the 3 tabs. So none of them is quite "every visible
-- person" -- this RPC is: everyone who's opted into being findable,
-- regardless of activity level, for Find Friends' "browse" list.
--
-- Deliberately NOT get_challengeable_users() (which already exists and
-- returns almost the same shape) -- that one is Duels-specific and, as of
-- tonight's fix, also filters candidates to is_premium=true, since a
-- non-Premium opponent can never actually accept a duel. That Premium
-- filter doesn't belong here: Find Friends is used for lower-tier flows
-- too (aircraft/folder invite creation only requires the INVITER to be
-- Premium, not the invitee -- join_shared_folder's own is_premium check
-- happens later, at accept time), so presumptively hiding non-Premium
-- opted-in people from being found at all would be wrong for this
-- broader purpose. Each downstream action keeps its own existing tier
-- check; this RPC's only job is "who opted in to being findable."
-- Inner join to callsign_registry (not left join + coalesce fallback, the
-- shape get_challengeable_users uses) deliberately: this list's whole
-- point is "tap someone to select them by Callsign," feeding straight
-- into onSelect(callsign) -> resolveCallsignToUserId or an
-- invite_*_collaborator RPC's p_callsign, both of which need a REAL
-- registered callsign, not a display-name/email-prefix fallback that
-- wouldn't actually resolve back to this person.
create or replace function public.get_visible_users()
 returns table(user_id uuid, display_label text)
 language sql
 stable
 security definer
as $function$
  select u.id as user_id, cr.callsign::text as display_label
  from user_streaks us
  join auth.users u on u.id = us.user_id
  join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true and u.id != auth.uid()
  order by 2;
$function$;

revoke all on function public.get_visible_users() from public, anon;
grant execute on function public.get_visible_users() to authenticated;
