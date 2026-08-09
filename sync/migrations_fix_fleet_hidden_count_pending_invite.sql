-- ============================================================================
-- Fix: get_fleet_hidden_count() counted a PENDING, unaccepted Callsign invite
-- as "hidden by the tier cap"  --  2026-08-09
--
-- Found via the same systematic sweep that caught the has_aircraft_access()
-- security leak (see migrations_fix_has_aircraft_access_pending_invite_leak.sql)
-- -- grepped every function referencing left_at/accepted_at/joined_at and
-- checked each one individually.
--
-- get_fleet_hidden_count() = greatest(candidate_count - get_fleet_summary()_count, 0).
-- get_fleet_summary() already correctly requires ac.accepted_at is not null
-- before counting a shared aircraft. But this function's own candidate_count
-- only filtered ac.left_at is null -- so an invitee with a still-pending
-- (unaccepted) Callsign invite was counted in candidate_count but never in
-- get_fleet_summary()'s count, inflating the "N aircraft hidden -- upgrade to
-- see them" figure by 1 for every outstanding pending invite, even on tiers
-- with no actual capacity problem. Not a data-exposure bug (this is a plain
-- count, no rows), just a wrong number surfaced in the downgrade-picker UI.
--
-- Added a regression check to scripts/aircraft_sharing_e2e_test.py: the
-- invitee's own get_fleet_hidden_count() must read 0 while their invite is
-- still pending.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_fleet_hidden_count()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  select greatest(
    (
      select count(*)::int
      from user_aircraft ua
      left join aircraft_collaborators ac on ac.aircraft_id = ua.id and ac.user_id = auth.uid() and ac.left_at is null and ac.accepted_at is not null
      where ua.user_id = auth.uid() or ac.user_id = auth.uid()
    ) - (select count(*)::int from public.get_fleet_summary()),
    0
  );
$$;
