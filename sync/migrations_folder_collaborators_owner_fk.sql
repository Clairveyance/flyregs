-- folder_collaborators.owner_id had no FK to auth.users (2026-09-03)
--
-- Found during the overnight account-lifecycle audit. Of the 27 user-
-- referencing columns in the schema, every one cascades on account deletion
-- EXCEPT this one -- verified end to end: user A creates a shared folder, B
-- joins, A deletes their account, and the folder_collaborators row survives
-- pointing at a uuid that no longer exists in auth.users.
--
-- `user_id` already has the cascade; `owner_id` never got one. The sibling
-- table aircraft_collaborators is covered transitively (aircraft_id ->
-- user_aircraft ON DELETE CASCADE -> user_id -> auth.users), but
-- folder_collaborators has no equivalent chain because folder_id is untyped
-- text with no FK of its own.
--
-- INERT TODAY, which is why this is low severity rather than a leak:
-- getMyCollaborations joins through synced_folders (which does cascade away),
-- and every related RPC inner-joins auth.users on owner_id and filters the row
-- out. So the collaborator sees nothing. But it is unbounded accumulation of
-- rows referencing deleted users, and delete-account's own header comment
-- claims the cascade already reaches "folder_collaborators" -- which was only
-- half true until now.
--
-- Safe to add: verified 0 orphaned owner_id rows exist (3 rows total), so the
-- constraint validates immediately.

begin;

alter table public.folder_collaborators
  add constraint folder_collaborators_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete cascade;

commit;
