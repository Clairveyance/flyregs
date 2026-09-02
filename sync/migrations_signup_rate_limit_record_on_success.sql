-- Only count signups that actually happened (2026-09-03)
--
-- check_and_record_signup_attempt() INSERTs the attempt row BEFORE the caller
-- has tried to sign up, and nothing ever removes it. So the counter measures
-- TAPS, not accounts. A password under 6 characters, a malformed email, a
-- transient network error, or Supabase's own email rate limit all throw AFTER
-- the slot is already spent.
--
-- Three of those inside an hour and a user who has created ZERO accounts is
-- told "Too many accounts created on this device recently" and cannot sign up
-- for an hour. deviceId persists in AsyncStorage, so the only escape is
-- reinstalling the app. RC has repeatedly reported signup problems; this is a
-- very plausible cause.
--
-- Split into check-then-record so the row is only written once the signup has
-- genuinely succeeded.
--
-- check_and_record_signup_attempt is DELIBERATELY LEFT IN PLACE and unchanged:
-- the shipped builds (B37/B38) call it, and they must keep working exactly as
-- they do today until a build ships that uses the pair below.
--
-- Both enforce the same hard cap of 3/hour the old function actually applied.
-- (Note the old signature takes p_max_per_hour and then ignores it in favour of
-- a hardcoded 3 -- the parameter has always been a lie. Not carried forward.)

begin;

create or replace function public.check_signup_attempt_allowed(p_device_id text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select count(*) < 3
  from device_signup_attempts
  where device_id = p_device_id
    and created_at > now() - interval '1 hour';
$function$;

create or replace function public.record_signup_attempt(p_device_id text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into device_signup_attempts (device_id) values (p_device_id);
$function$;

revoke execute on function public.check_signup_attempt_allowed(text) from public;
revoke execute on function public.record_signup_attempt(text) from public;
grant execute on function public.check_signup_attempt_allowed(text) to anon, authenticated;
grant execute on function public.record_signup_attempt(text) to anon, authenticated;

commit;
