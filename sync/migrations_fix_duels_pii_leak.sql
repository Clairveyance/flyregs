-- Found by a dedicated gating-audit agent, 2026-08-14: the whole Duels
-- screen (src/app/challenges/index.tsx) is gated client-side on
-- isPremium, but two of the RPCs it calls have ZERO server-side
-- entitlement check -- unlike their siblings create_challenge/
-- respond_to_challenge/submit_challenge_answer, which all correctly
-- check is_premium. Same "client-only gate, no server enforcement" shape
-- already found and fixed multiple times this session, just not yet
-- caught in this specific pair of functions.
--
-- Live-proven exploit before writing this fix: a disposable Free-tier
-- test account (zero user_entitlements row) called
-- rpc/get_challengeable_users directly with its own JWT and got HTTP 200
-- back with 3 real rows, including the production owner account itself
-- ({'user_id': '37008a21-...', 'display_label': 'RC'}) -- any signed-in
-- account, paid or not, could enumerate real users' callsigns/display
-- names and internal user_ids this way. The leaked user_ids are also
-- exactly the input get_duel_stats(p_user_id) accepts with no ownership
-- check at all -- a second disposable account then called
-- get_duel_stats with the FIRST account's id and got its real win/loss/
-- tie counts back. Low sensitivity payload on that second one, but a
-- real unauthenticated-by-tier enumeration primitive with no legitimate
-- purpose: grepped every real call site (src/lib/challenges.ts,
-- src/app/challenges/index.tsx, src/app/challenges/[id].tsx) and
-- getDuelStats() is ALWAYS called with no argument (p_user_id always
-- null, resolving to auth.uid()) -- nothing in the shipped app ever
-- actually looks up another user's stats, so dropping that capability
-- entirely costs nothing real.
CREATE OR REPLACE FUNCTION public.get_challengeable_users()
 RETURNS TABLE(user_id uuid, display_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  return query
  select u.id, coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text
  from user_streaks us
  join auth.users u on u.id = us.user_id
  left join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true and u.id != auth.uid()
  order by display_label;
end;
$function$;

-- Signature unchanged (p_user_id stays in the shape for API stability)
-- but its value is now ignored -- v_uid always resolves to the caller's
-- own auth.uid(), never an arbitrary passed-in id, matching what every
-- real call site already does in practice.
CREATE OR REPLACE FUNCTION public.get_duel_stats(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(wins integer, losses integer, ties integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  return query
  select coalesce(s.wins,0), coalesce(s.losses,0), coalesce(s.ties,0)
  from (select 1) as dummy
  left join user_duel_stats s on s.user_id = v_uid;
end;
$function$;
