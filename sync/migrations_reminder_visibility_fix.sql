-- ============================================================================
-- Fix aircraft owner unable to see Reminders their editor-collaborator adds
-- -- 2026-08-05
--
-- Found via a real dual-account test (see gotcha_aircraft_share_reminder_
-- visibility.md): user_aircraft_reminders_own_rows required
-- `auth.uid() = user_id` (the CURRENT viewer must be the row's own creator)
-- on top of aircraft ownership. Since the aircraft owner is never a row in
-- aircraft_collaborators (they're tracked via user_aircraft.user_id, not as
-- a collaborator of their own plane), the sibling collaborator-view policy
-- never covers them either -- net effect, an owner could only ever see
-- reminders THEY personally typed, never ones a delegated mechanic/co-owner
-- added. The write always succeeded; it just became permanently invisible
-- to the person the delegation was for.
--
-- Fix: same shape user_aircraft_equipment_own_rows already uses correctly
-- -- check aircraft ownership only, drop the creator-identity requirement.
-- This ONLY widens the owner's visibility into their own aircraft's own
-- data; it does not expose anything to a non-owner, non-collaborator
-- (verified live: an unrelated account still sees zero rows on an aircraft
-- it has no relationship to). Also gives the owner full UPDATE/DELETE over
-- a collaborator's reminder, not just SELECT -- confirmed live (owner
-- edited then deleted a collaborator-created reminder after this change).
--
-- Verified end-to-end with a real second account (not just policy-text
-- reading): collaborator inserts a reminder -> owner's RLS-enforced query
-- (fresh token, not service-role) now sees it immediately, alongside their
-- own pre-existing reminders. Matches the sibling equipment table's already
-- -proven pattern exactly, so this also makes every own-rows policy on this
-- table family consistent with itself.
-- ============================================================================

ALTER POLICY user_aircraft_reminders_own_rows ON user_aircraft_reminders
  USING (
    EXISTS (
      SELECT 1 FROM user_aircraft ua
      WHERE ua.id = user_aircraft_reminders.user_aircraft_id
        AND ua.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_aircraft ua
      WHERE ua.id = user_aircraft_reminders.user_aircraft_id
        AND ua.user_id = auth.uid()
    )
  );
