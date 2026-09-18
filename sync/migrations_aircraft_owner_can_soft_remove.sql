-- The owner could DELETE an aircraft collaborator row but never UPDATE one.
--
-- Follow-up to migrations_collaborator_removal_is_soft.sql, found by its own
-- test on the very first run after applying it. That migration turned removal
-- into an UPDATE on both tables. folder_collaborators already had an owner
-- UPDATE policy (owners_update_collaborator_mode, which the per-person
-- read/write toggle needs). aircraft_collaborators never did -- role changes
-- there go through the SECURITY DEFINER update_aircraft_collaborator_role RPC,
-- which bypasses RLS, so nothing had ever needed one.
--
-- The failure mode is the reason this is worth a migration of its own rather
-- than a footnote: PostgREST answers an UPDATE that matches ZERO rows with a
-- SUCCESS. supabase-js therefore returns no error, and removeCollaborator
-- resolved happily while the collaborator kept full access -- a "Remove
-- Access" button that removes nothing and says it worked. Exactly the shape of
-- gotcha_deliberate_revoke_needs_client_guard and the leaveSharedAircraft
-- silent no-op before it.
--
-- Fixed on BOTH sides, per the standing rule that a guard belongs on the side
-- that cannot be stale AND on the side the user is standing on:
--   * here -- the owner may update their own collaborators' rows;
--   * in aircraftSharing.ts / sharedFolders.ts -- removeCollaborator now asks
--     for the changed row back and throws if none came, so a future missing
--     policy is loud instead of silent.

begin;

create policy owners_update_aircraft_collaborators
  on aircraft_collaborators
  for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

commit;
