-- Fix Find Friends: match_contacts_by_email could never run.
--
-- Found 2026-09-04 by account_findfriends_e2e_test.py, which failed for BOTH
-- the pro and premium callers with:
--   HTTP 404  42883  function digest(text, unknown) does not exist
--
-- Root cause: pgcrypto is installed in the `extensions` schema on this
-- project, but the function is SECURITY DEFINER with
--   SET search_path TO 'public', 'pg_temp'
-- which does not include `extensions`, so the two unqualified digest() calls
-- could not resolve. The function raised every time it was called.
--
-- Effect on real users: "Find Friends by contacts" was completely dead for
-- every Pro and Premium subscriber -- the whole point of the feature, matching
-- your phone contacts against FlyRegs users by email hash, always errored.
--
-- Fix is to fully qualify as extensions.digest(...), NOT to add `extensions`
-- to the search_path. Widening the search_path of a SECURITY DEFINER function
-- is a security regression: it lets anything resolvable earlier on that path
-- shadow a call made with the definer's elevated rights. Qualifying is exact
-- and changes nothing else.
--
-- encode() needs no qualification -- it is a pg_catalog built-in, always in scope.
CREATE OR REPLACE FUNCTION public.match_contacts_by_email(p_email_hashes text[])
 RETURNS TABLE(email_hash text, callsign text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.has_pro_access() then
    raise exception 'Find Friends requires Pro';
  end if;

  return query
  select encode(extensions.digest(lower(btrim(u.email)), 'sha256'), 'hex') as email_hash, cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.email is not null
    and encode(extensions.digest(lower(btrim(u.email)), 'sha256'), 'hex') = any(p_email_hashes);
end;
$function$;
