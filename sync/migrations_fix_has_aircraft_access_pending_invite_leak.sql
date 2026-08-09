-- ============================================================================
-- Fix: has_aircraft_access() granted real read/write access to a PENDING,
-- unaccepted Callsign invite  --  2026-08-09
--
-- Found while building scripts/aircraft_sharing_e2e_test.py (aircraft
-- sharing had zero re-runnable regression coverage before this -- see
-- PROJECT_NOTES/flyregs_pending.md's "Real gap found 2026-08-08" entry).
--
-- invite_aircraft_collaborator() creates an aircraft_collaborators row with
-- accepted_at = NULL the moment an owner invites someone by Callsign -- the
-- roster is meant to show that row greyed out as "Invited" until the
-- invitee actually opens the link and calls join_shared_aircraft(), which
-- stamps accepted_at. But has_aircraft_access() -- the actual RLS gate on
-- user_aircraft / user_aircraft_equipment / user_aircraft_reminders -- only
-- ever checked `left_at IS NULL`, never `accepted_at IS NOT NULL`. So from
-- the instant the invite row existed, the invited Callsign already had
-- real read (or write, if invited as editor) access to the owner's
-- aircraft data via any direct API/RPC call -- no UI route surfaced it
-- (the app doesn't send them anywhere until they "accept"), but the
-- server-side gate itself did not enforce the distinction at all.
--
-- get_profile_avatar() (a different function touching the same table)
-- already correctly required `ac.accepted_at is not null` -- confirming
-- this was an oversight in has_aircraft_access(), not a deliberate design
-- choice that avatar visibility alone happened to diverge from.
--
-- Verified live: zero real pending (accepted_at IS NULL) aircraft_collaborators
-- rows existed in production at the time of this fix -- no real invite was
-- ever actually exposed by this, it was caught before it had a live victim.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_aircraft_access(p_aircraft_id uuid, p_require_editor boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  select exists (
    select 1 from aircraft_collaborators ac
    where ac.aircraft_id = p_aircraft_id
      and ac.user_id = auth.uid()
      and ac.left_at is null
      and ac.accepted_at is not null
      and (not p_require_editor or ac.role = 'editor')
  );
$$;
