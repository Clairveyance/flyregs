-- Two fixes, both about the same thing: the app must predict the duel gate
-- using the SAME condition the gate actually applies, and must name the right
-- setting when it blocks.
--
-- 1. find_users_for_invite.duel_ready was computed as
--      duel_notifications_enabled AND has_pro_access(u.id)
--    Both halves were wrong for this purpose:
--      * duel_notifications_enabled is a PUSH preference. Someone with duel
--        pushes off can be duelled perfectly well -- they just find out when
--        they open the app. Greying them out in the invite list would deny an
--        invite that the server would have accepted.
--      * has_pro_access() is `is_pro OR is_premium`. Duels are PREMIUM-only.
--        A Pro user would have shown as duel-ready and then been rejected by
--        create_challenge after the searcher had already added them.
--    The real precondition, read straight out of create_challenge, is
--      user_streaks.leaderboard_opt_in = true AND user_entitlements.is_premium
--    and the search already filters to opted-in users, so duel_ready is
--    exactly is_premium. A predicted state that disagrees with the gate is
--    worse than no prediction: it makes the UI lie in both directions.
--
-- 2. create_challenge's own message for the opt-in half said
--      "% hasn't enabled Duel challenges yet."
--    There is no "Duel challenges" setting. The missing switch is "Show me on
--    the Ready Room leaderboard" (Account > The Wing), so anyone who went
--    looking for the named toggle found their Duel Alerts already on and had
--    nowhere to go. Only the message text changes; the gate is untouched.

begin;

create or replace function public.find_users_for_invite(p_query text)
returns table (
  user_id uuid,
  callsign text,
  avatar_url text,
  avatar_preset text,
  match_kind text,       -- 'callsign' | 'phone' | 'email', for UI copy
  duel_ready boolean     -- mirrors create_challenge's gate exactly
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_digits text := public.normalize_phone(v_q);
  v_kind text;
begin
  if not public.has_pro_access(auth.uid()) then
    raise exception 'Inviting requires Pro';
  end if;
  if length(v_q) < 2 then
    return;
  end if;

  if position('@' in v_q) > 0 then
    v_kind := 'email';
  elsif length(v_digits) >= 10 then
    v_kind := 'phone';
  else
    v_kind := 'callsign';
  end if;

  return query
  select
    u.id,
    cr.callsign::text,
    u.raw_user_meta_data->>'avatar_url',
    u.raw_user_meta_data->>'avatar_preset',
    v_kind,
    -- The rows reaching here are already leaderboard_opt_in = true (the WHERE
    -- below), so the only remaining half of create_challenge's gate is
    -- Premium. Keep this in step with create_challenge if that gate changes.
    exists (select 1 from user_entitlements ue
             where ue.user_id = u.id and ue.is_premium = true)
  from auth.users u
  join user_streaks us on us.user_id = u.id
  left join callsign_registry cr on cr.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and (
      (v_kind = 'email'
        and lower(u.email) = lower(v_q))
      or (v_kind = 'phone'
        and public.normalize_phone(u.raw_user_meta_data->>'phone_number') = v_digits
        and length(public.normalize_phone(u.raw_user_meta_data->>'phone_number')) >= 10)
      or (v_kind = 'callsign'
        and cr.callsign_lower is not null
        and cr.callsign_lower like lower(v_q) || '%')
    )
  order by
    case when cr.callsign_lower = lower(v_q) then 0 else 1 end,
    cr.callsign
  limit 25;
end;
$$;

revoke all on function public.find_users_for_invite(text) from public, anon;
grant execute on function public.find_users_for_invite(text) to authenticated;

commit;
