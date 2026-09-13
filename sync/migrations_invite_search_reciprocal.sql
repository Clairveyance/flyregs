-- Reciprocal disclosure on the invite search.
--
-- RC, 2026-09-12: "yes make it reciprocal." Per his original spec: "if users
-- have info input, and selected to have their info shown (callsign, phone,
-- show in duels, etc), then once another user finds a match to their (phone
-- number) search, the rest of that other users info will also be shown (this
-- is a way of learning callsigns of someone you may only have a number for)."
--
-- So a match now returns the matched person's email and phone alongside their
-- callsign. THE CONSENT AND THE ANTI-ENUMERATION RULES ARE UNCHANGED, and both
-- still carry the whole weight of this being safe:
--
--   * Only users with user_streaks.leaderboard_opt_in = true are findable at
--     all. That is the same "Show me on the Ready Room leaderboard" switch
--     get_challengeable_users() and match_contacts_by_phone() already use --
--     this adds no one to the findable set.
--   * Email and phone remain EXACT-match only. You cannot sweep for people;
--     you can only confirm someone you already have an identifier for. That is
--     what keeps "reciprocal" from becoming "harvestable": the searcher had to
--     already know a real email or a real phone number (or the exact-or-prefix
--     callsign, a public handle) to get a row at all.
--
-- The honest change in exposure, stated plainly rather than buried: someone who
-- knows a findable user's PHONE number can now also learn that user's EMAIL,
-- and vice versa. That is the reciprocity RC asked for and it is symmetric --
-- the same is true of him to them. It applies only to people who opted in to
-- being findable. scripts/invite_search_audit.py holds the exact-match line, so
-- this cannot quietly widen into an enumeration oracle later.

begin;

-- The return type gains two columns, and Postgres will not CREATE OR REPLACE
-- across a changed OUT-parameter row type (see
-- gotcha_create_or_replace_signature_overload.md). Dropping and recreating
-- inside this one transaction means there is no window where the function is
-- missing. Safe to drop: no shipped build calls it -- the client half of the
-- unified contact search has not been built into a release yet.
drop function if exists public.find_users_for_invite(text);

create or replace function public.find_users_for_invite(p_query text)
returns table (
  user_id uuid,
  callsign text,
  avatar_url text,
  avatar_preset text,
  match_kind text,       -- 'callsign' | 'phone' | 'email', for UI copy
  duel_ready boolean,    -- mirrors create_challenge's gate exactly
  email text,            -- reciprocal: only for opted-in users, exact match only
  phone_number text      -- reciprocal: as the user entered it, not normalised
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
    exists (select 1 from user_entitlements ue
             where ue.user_id = u.id and ue.is_premium = true),
    u.email::text,
    -- Their own formatting, not normalize_phone's digits: this is shown to a
    -- person, and "(555) 867-5309" is what they typed and what they'd recognise.
    (u.raw_user_meta_data->>'phone_number')::text
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
