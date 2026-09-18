-- Deleting your account must take YOUR work, not other people's.
--
-- Found 2026-09-17 by scripts/account_deletion_shared_data_test.py, written
-- while looking for what beta had not covered. delete-account (the edge
-- function) is careful about storage objects and stray identifiers, and every
-- app table hangs off auth.users ON DELETE CASCADE so nothing is left behind.
-- Nobody had asked what that cascade does to the SHARED side.
--
-- THE BUG, proven live. A folder ENTRY (synced_folder_items) belongs to
-- whoever FILED it, not to whoever wrote the thing it points at. So when a
-- collaborator files the OWNER's note into the owner's shared folder -- an
-- ordinary thing to do, and exactly what read/write access is for -- that row
-- is the COLLABORATOR's. Their account deletion cascades it away, and the
-- owner's own note silently leaves the owner's own folder. The note survives;
-- its place does not, and nothing tells anyone.
--
-- THE SAME SHAPE, WORSE. user_aircraft_reminders.user_id cascades identically.
-- A collaborator who adds a maintenance reminder to somebody else's aircraft
-- and later deletes their account takes that reminder with them. The owner is
-- left short a maintenance item they were relying on, with no trace. (Its
-- sibling user_aircraft_equipment is keyed to the AIRCRAFT and has no user_id
-- at all, so it was never exposed -- the difference is the whole point.)
--
-- THE RULE, and it is the same one migrations_collaborator_removal_is_soft.sql
-- settled: something you put into someone else's folder or aircraft belongs to
-- that folder or aircraft now. Losing access to it, by removal or by deleting
-- your account, does not un-put it.
--
-- WHY A TRIGGER ON auth.users RATHER THAN A STEP IN delete-account.  The edge
-- function is one of several ways a user can vanish -- the Supabase dashboard,
-- a service-role delete, a future admin tool. A guard that lives in the
-- function protects only the path that remembers to call it. This one cannot
-- be bypassed, and auth.users already carries two project triggers
-- (on_auth_user_created_entitlements, on_auth_user_confirmed), so it is an
-- established pattern here rather than a novel one.
--
-- WHAT IS DELIBERATELY *NOT* RESCUED. A person's own notes and their own
-- highlights go with them; that is their data and deleting it is the point of
-- the feature. So an entry is only re-homed when the thing it points at will
-- still exist afterwards -- a public regulation, or content somebody else
-- wrote. An entry pointing at the departing user's own note or own highlight
-- is left to cascade, because re-homing it would leave the owner looking at a
-- row that opens nothing, which is worse than the row being gone.

begin;

create or replace function public.rehome_shared_work_on_user_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Folder entries this person filed into somebody ELSE's folder.
  update synced_folder_items sfi
     set user_id = sf.user_id
    from synced_folders sf
   where sf.id = sfi.folder_id
     and sfi.user_id = old.id
     and sf.user_id <> old.id
     -- Only when the thing it points at outlives them (see header).
     and not exists (
       select 1 from synced_notes n
        where sfi.item_type = 'note' and n.id = sfi.item_id and n.user_id = old.id)
     and not exists (
       select 1 from synced_bookmarks b
        where b.id = sfi.item_id and b.user_id = old.id);

  -- Maintenance reminders this person added to somebody ELSE's aircraft.
  update user_aircraft_reminders r
     set user_id = ua.user_id
    from user_aircraft ua
   where ua.id = r.user_aircraft_id
     and r.user_id = old.id
     and ua.user_id <> old.id;

  return old;
end;
$$;

drop trigger if exists on_auth_user_delete_rehome_shared_work on auth.users;
create trigger on_auth_user_delete_rehome_shared_work
  before delete on auth.users
  for each row execute function public.rehome_shared_work_on_user_delete();

commit;
