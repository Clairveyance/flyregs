-- Find Friends by phone number never worked. Not once.
--
-- Found 2026-09-17 by calling every RPC the app uses as every tier and reading
-- what came back. match_contacts_by_phone answered, for Pro AND Premium:
--
--     function digest(text, unknown) does not exist
--
-- That is not a permission message and not a "no matches" -- it is the function
-- failing outright, every single time, for every entitled user.
--
-- WHY. Supabase installs pgcrypto into the `extensions` schema, not `public`.
-- This function is pinned to `SET search_path TO 'public', 'pg_temp'`, so a bare
-- `digest(...)` is unresolvable. Its sibling, match_contacts_by_email, calls
-- `extensions.digest(...)` fully qualified and works fine -- the two were
-- written to the same design and only one of them got the schema right.
--
-- The pinned search_path is itself correct and must stay: a SECURITY DEFINER
-- function with a loose search_path is a privilege-escalation hazard. The fix is
-- to qualify the call, exactly as the email version already does.
--
-- WHY IT WAS NEVER NOTICED. contactMatch.ts hashes phone numbers on the device
-- and sends only hashes, then merges the email and phone results together. A
-- thrown phone lookup just meant the merged list came back with email matches
-- only -- indistinguishable from "none of your contacts by phone are on
-- FlyRegs", which for a small beta is exactly what you'd expect to see. It looked
-- like an empty result. It was a hard error.
--
-- This matters more than the email half: the app's own code comment says it,
-- "phone numbers, not emails, for personal contacts."

begin;

create or replace function public.match_contacts_by_phone(p_phone_hashes text[])
returns table(phone_hash text, callsign text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.has_pro_access() then
    raise exception 'Find Friends requires Pro';
  end if;

  return query
  select encode(extensions.digest(public.normalize_phone(u.raw_user_meta_data->>'phone_number'), 'sha256'), 'hex') as phone_hash,
         cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.raw_user_meta_data->>'phone_number' is not null
    and length(public.normalize_phone(u.raw_user_meta_data->>'phone_number')) > 0
    and encode(extensions.digest(public.normalize_phone(u.raw_user_meta_data->>'phone_number'), 'sha256'), 'hex') = any(p_phone_hashes);
end;
$function$;

commit;
