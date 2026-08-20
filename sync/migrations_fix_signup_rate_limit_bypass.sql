-- 2026-08-19/20, gating sweep round 2 (different access points) -- Bug found
-- via systematic SECURITY DEFINER GRANT EXECUTE audit, the "look for a
-- function that should be admin/service-only but is actually exposed to
-- anon/authenticated with caller-controlled internals" pattern.
--
-- check_and_record_signup_attempt(p_device_id, p_max_per_hour) is a
-- per-device signup rate limiter, called from src/context/auth.tsx's
-- signUp() with a hardcoded p_max_per_hour=3 -- its own code comment says
-- "enforced server-side via a SECURITY DEFINER function so it can't be
-- bypassed by just not calling it." True for the CLIENT'S call, but the RPC
-- is exposed to anon via PostgREST at rpc/check_and_record_signup_attempt,
-- and p_max_per_hour is a plain caller-supplied parameter with no server-
-- side ceiling -- so anyone can call the RPC directly with an arbitrarily
-- large p_max_per_hour and the "recent_count >= p_max_per_hour" check never
-- trips, fully defeating the limiter regardless of how many prior attempts
-- are already on record for that device_id.
--
-- Live-confirmed before this fix: exhausted the real 3/hr limit for a fresh
-- test device_id (calls 1-3 -> true, call 4 with p_max_per_hour=3 -> false,
-- correctly blocked) -- then call 5, same already-exhausted device_id, with
-- p_max_per_hour=999999 -> true, immediately unblocked.
--
-- Fix: keep the existing signature (zero client change needed, matches the
-- existing rpc call in auth.tsx) but stop trusting the caller-supplied
-- threshold for the actual gate -- compare against a fixed server-side
-- constant instead. The parameter is still accepted (so the same PostgREST
-- signature keeps resolving) but is no longer load-bearing for enforcement.
CREATE OR REPLACE FUNCTION public.check_and_record_signup_attempt(p_device_id text, p_max_per_hour integer DEFAULT 3)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  recent_count int;
  v_enforced_max_per_hour constant int := 3;
begin
  select count(*) into recent_count
  from device_signup_attempts
  where device_id = p_device_id
    and created_at > now() - interval '1 hour';

  if recent_count >= v_enforced_max_per_hour then
    return false;
  end if;

  insert into device_signup_attempts (device_id) values (p_device_id);
  return true;
end;
$function$;
