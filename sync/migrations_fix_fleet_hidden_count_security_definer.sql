-- Fixes P0-1 from the 2026-08-22 gating audit: get_fleet_hidden_count()
-- always returned 0, so AircraftDowngradeGate (the ONLY downgrade UX for
-- over-cap aircraft) never fired, and getOwnedAircraftOldestFirst()/
-- keepOnlyAircraft() could never see or delete a hidden row -- confirmed
-- live: a Premium account with 4 aircraft downgraded to Pro (cap 1) had 3
-- aircraft permanently invisible and undeletable, with zero UI telling
-- the user they still existed.
--
-- Root cause: this function was NOT security definer, so its own
-- `user_aircraft` query ran under the CALLING user's RLS
-- (user_aircraft_own_select requires is_aircraft_visible_row(...)),
-- meaning it only ever saw the already-visible rows -- computing
-- "visible minus visible = 0" no matter how many were actually hidden.
--
-- Fix: security definer (bypasses RLS for this function's own query,
-- exactly like is_aircraft_visible_row() already does for the same
-- reason), and count visible-vs-hidden directly via
-- is_aircraft_visible_row() in one self-contained query rather than
-- delegating to get_fleet_summary() -- avoids any ambiguity about
-- whether a SECURITY INVOKER function nested inside a now-DEFINER caller
-- still applies RLS correctly.
create or replace function public.get_fleet_hidden_count()
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int
  from user_aircraft ua
  left join aircraft_collaborators ac
    on ac.aircraft_id = ua.id and ac.user_id = auth.uid() and ac.left_at is null and ac.accepted_at is not null
  where (ua.user_id = auth.uid() or ac.user_id = auth.uid())
    and not is_aircraft_visible_row(ua.user_id, ua.created_at, ua.id);
$function$;
