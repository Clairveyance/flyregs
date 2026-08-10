-- Night-rules relational-integrity sweep, 2026-08-09.
--
-- aircraft_collaborators was the only user_id column in the entire schema
-- without a FK to auth.users(id) ON DELETE CASCADE. Every sibling table --
-- folder_collaborators, push_tokens, synced_folders, synced_folder_items,
-- synced_bookmarks, user_aircraft, user_aircraft_reminders,
-- user_ad_notifications, callsign_registry -- has that constraint.
-- aircraft_collaborators (added 2026-08-04) only got aircraft_id ->
-- user_aircraft(id) ON DELETE CASCADE; owner_id/user_id were left as bare
-- uuids.
--
-- Effect: when a collaborator (invitee) deletes their own account via
-- supabase/functions/delete-account/index.ts, the admin auth.users delete
-- cascades to every table listed in that function's own comment -- and
-- aircraft_collaborators is conspicuously NOT in that list -- so the
-- collaborator's row silently survives, pointing at a user_id that no
-- longer exists anywhere (confirmed: zero footprint in any other table,
-- no auth.audit_log_entries trace).
--
-- Found one live instance: aircraft_id a9a99cad-5698-42d6-b273-53a8b6cf0d41
-- (owner ryan-preview-1785031854@flyregs.com's "N4471M"), user_id
-- 33d893b1-e956-4f8f-89eb-800535874b6e, role editor, accepted 2026-08-08.
-- That row was deleted directly (SQL run via scripts/apply_migration.py,
-- not via this file) after confirming the target user_id has zero
-- footprint anywhere else in the DB. This file only carries the schema fix
-- so it's reproducible/idempotent for any future environment.
--
-- owner_id is intentionally left alone: user_aircraft.user_id already
-- cascades ON DELETE to auth.users, and aircraft_collaborators.aircraft_id
-- cascades ON DELETE from user_aircraft -- so an owner's account deletion
-- already transitively removes their aircraft_collaborators rows. Only
-- user_id (the collaborator side) had the real gap.

alter table aircraft_collaborators
  add constraint aircraft_collaborators_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
