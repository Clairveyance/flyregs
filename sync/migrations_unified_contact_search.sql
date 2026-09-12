-- One invite search bar that accepts a callsign, a phone number, or an email.
--
-- RC, 2026-09-11: "we need the 'invite' search popup for all places (duels,
-- folders, a/c, etc) capable of searching everything in the one search bar --
-- Callsign, phone number, email, etc. some users may not know another's
-- callsign, but have their phone... and of course, it needs to be smart. ie, a
-- phone number can be put in as only the digits, or have the dashes, or even
-- just spaces - and our sys must be smart enough to search our DB of stored
-- numbers and find a match."
--
-- Before this there were three separate, incompatible paths:
--   lookup_user_by_callsign()   exact callsign only
--   match_contacts_by_phone()   bulk hash matching, for the address-book import
--   match_contacts_by_email()   same, by email
-- and the invite fields in Duels / folders / aircraft only ever called the
-- first one. Someone who had a student's phone number but not their callsign
-- had no way to invite them at all.
--
-- WHAT COUNTS AS A MATCH
--   contains '@'        -> email, EXACT only
--   >= 10 digits        -> phone, exact on normalize_phone() (which already
--                          strips dashes/spaces/parens and prepends the US 1
--                          for a bare 10-digit number, so 555-123-4567,
--                          5551234567, "555 123 4567" and +1 555 123 4567 all
--                          resolve to the same key)
--   otherwise           -> callsign, exact OR prefix
--
-- WHY EMAIL AND PHONE ARE EXACT-MATCH ONLY, AND DELIBERATELY NOT PREFIX
-- A prefix or fuzzy search over email or phone is an enumeration oracle: feed
-- it "a", then "b", and it hands back the userbase. A callsign is a public
-- handle -- it is already displayed in Ready Room and on every duel -- so
-- prefixing THAT discloses nothing new. An email address and a phone number
-- are not public handles, and you only find someone by one if you already know
-- it. This is the same reasoning as gotcha_public_bucket_select_policy_enables
-- _enumeration.md: the lookup is fine, the ability to sweep is not.
--
-- WHAT IS RETURNED, AND WHAT IS NOT
-- RC: "if users have info input, and selected to have their info shown... then
-- once another user finds a match to their (phone number) search, the rest of
-- that other users info will also be shown (this is a way of learning
-- callsigns of someone you may only have a number for)."
--
-- So a match returns the user's CALLSIGN, avatar, and whether they can be
-- duelled. It deliberately does NOT return their email or phone back to the
-- searcher. Learning a callsign from a number you already have is the stated
-- goal; being handed an email address because you guessed a phone number is a
-- different thing, and would turn one known contact detail into a harvest of
-- the rest. If RC wants that reciprocity too it is one line, but it should be
-- his decision made knowingly, not a side effect of this one.
--
-- CONSENT
-- Only users with user_streaks.leaderboard_opt_in = true are findable -- the
-- same "Show Me" switch get_challengeable_users() and match_contacts_by_phone()
-- already use, so this introduces no new sharing anyone has not already agreed
-- to. Searching still requires Pro, matching the existing invite paths.

begin;

create or replace function public.find_users_for_invite(p_query text)
returns table (
  user_id uuid,
  callsign text,
  avatar_url text,
  avatar_preset text,
  match_kind text,       -- 'callsign' | 'phone' | 'email', for UI copy
  duel_ready boolean     -- so the caller can say WHY someone can't be duelled
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
  -- Two characters is the floor for a callsign prefix; below that every search
  -- returns most of the userbase, which is the sweep this is meant to prevent.
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
    coalesce(pt.duel_notifications_enabled, false) and public.has_pro_access(u.id)
  from auth.users u
  join user_streaks us on us.user_id = u.id
  left join callsign_registry cr on cr.user_id = u.id
  left join lateral (
    select bool_or(p.duel_notifications_enabled) as duel_notifications_enabled
    from push_tokens p where p.user_id = u.id
  ) pt on true
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
    -- exact callsign first, then alphabetical: a search for "LEAD" must not
    -- bury LEAD under LEADFOOT.
    case when cr.callsign_lower = lower(v_q) then 0 else 1 end,
    cr.callsign
  limit 25;
end;
$$;

revoke all on function public.find_users_for_invite(text) from public, anon;
grant execute on function public.find_users_for_invite(text) to authenticated;

commit;
