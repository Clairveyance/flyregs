-- An AD compliance record must outlive the account that signed it off.
--
-- Third instance of the same defect, found 2026-09-18 by sweeping structurally
-- for the pattern instead of waiting to trip over it: every table that carries
-- BOTH a user_id cascading off auth.users AND a foreign key into a container
-- somebody else owns. That query returns exactly three rows that matter, and
-- this is the last and worst of them:
--
--   synced_folder_items   -> synced_folders   (fixed: the owner's note left the
--                                              owner's folder)
--   user_aircraft_reminders -> user_aircraft  (fixed: a maintenance reminder
--                                              left the owner's aircraft)
--   user_ad_notifications -> user_aircraft    (THIS ONE)
--
-- user_ad_notifications is not really a notifications table. It carries
-- complied_at, complied_by, complied_note and compliance_kind -- an
-- AIRWORTHINESS DIRECTIVE COMPLIANCE RECORD. So an editor who signs off an AD
-- on somebody else's aircraft and later deletes their account takes that
-- sign-off with them, and the aircraft owner is left with an AD silently back
-- in "needs action" and no trace that it was ever addressed. Of everything this
-- pattern has destroyed today, this is the one with real-world consequences.
--
-- Proven live before the fix: the record simply vanished.
--
-- complied_by is deliberately NOT rewritten. It has no foreign key, so it
-- survives the deletion on its own, and it answers a different question from
-- user_id: user_id is "whose row is this / who does it belong to now", and
-- complied_by is "who actually did the work". Re-homing the first while
-- preserving the second is the whole point -- an airworthiness record that
-- changed custody must not quietly change its attribution too.

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

  -- AD compliance this person signed off on somebody ELSE's aircraft.
  -- Only rows that actually carry a compliance mark: an un-actioned
  -- notification row is a per-person delivery record and belongs to the person,
  -- so it should still go with them.
  update user_ad_notifications n
     set user_id = ua.user_id
    from user_aircraft ua
   where ua.id = n.user_aircraft_id
     and n.user_id = old.id
     and ua.user_id <> old.id
     and n.complied_at is not null;

  return old;
end;
$$;

commit;
