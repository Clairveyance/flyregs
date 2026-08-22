-- Fixes P0-1 from the 2026-08-22 gating audit (part 2 of 2 -- see
-- migrations for get_fleet_hidden_count for part 1). Confirmed live: a
-- Premium account with 4 aircraft downgraded to Pro (cap 1) -- the
-- downgrade-choice UI's own data calls, getOwnedAircraftOldestFirst() and
-- keepOnlyAircraft(), are both plain PostgREST calls against user_aircraft
-- relying on RLS to scope them to "this user's own rows." That assumption
-- predates migrations_fix_user_aircraft_select_returning.sql, which
-- (correctly, for a real read-bypass it was closing) added a visibility
-- CAP to the SELECT policy on top of ownership -- so these two calls can
-- now only ever see/touch the 1 already-visible aircraft: the picker can't
-- show the other 3 to choose from, and the DELETE silently affects 0 rows
-- for any of them (Postgres requires SELECT-visibility as a prerequisite
-- for UPDATE/DELETE to touch a row at all).
--
-- Fix: two new, narrow SECURITY DEFINER RPCs scoped internally by
-- auth.uid() (never trusting a client-supplied user id), used ONLY for
-- this legitimate "choose which aircraft to keep" recovery flow. This
-- does NOT reopen the general read-bypass the later migration closed --
-- the general user_aircraft SELECT policy (still capped) is untouched;
-- these RPCs are a separate, deliberate exception for a user managing
-- their OWN full set during a real downgrade, not a broadened read path.
create or replace function public.get_owned_aircraft_oldest_first()
 returns table(aircraft_id uuid, make text, model text, nickname text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select id, make, model, nickname
  from user_aircraft
  where user_id = auth.uid()
  order by created_at asc, id asc;
$function$;

grant execute on function public.get_owned_aircraft_oldest_first() to authenticated;

create or replace function public.keep_only_aircraft(p_keep_ids uuid[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  delete from user_aircraft
  where user_id = auth.uid()
    and (p_keep_ids is null or not (id = any(p_keep_ids)));
end;
$function$;

grant execute on function public.keep_only_aircraft(uuid[]) to authenticated;
