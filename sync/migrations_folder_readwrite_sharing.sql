-- Per-folder read/write collaboration mode.
-- RC's design: the OWNER sets read-only vs read/write PER FOLDER (case by
-- case), not per person -- the same person can be a plain viewer on one
-- shared folder and a full editor on another. This mirrors the proven
-- aircraft-sharing pattern (has_aircraft_access / editors_manage_shared_equipment)
-- but swaps aircraft_collaborators' per-person `role` column for a per-FOLDER
-- flag, since folder_collaborators has no role column and isn't meant to.
--
-- Ported forward from the Reminders bug (user_aircraft_reminders, fixed
-- 2026-08-04): an RLS policy scoped to auth.uid() = user_id (row creator)
-- rather than to ownership of the parent resource makes a collaborator's
-- write invisible to the resource's OWNER, since the owner is never itself
-- a row in the collaborators join table. Fixed here from the start rather
-- than discovered later: synced_folder_items' and synced_notes' owner
-- policies are rewritten below to check folder ownership, not creator
-- identity.

-- 1. Per-folder collaboration mode.
alter table synced_folders
  add column collab_mode text not null default 'read_only'
  check (collab_mode in ('read_only', 'read_write'));

-- 2. Collaborator access check, mirroring has_aircraft_access's scope exactly
--    (collaborator-only -- ownership is always a separate policy, never
--    folded into this function).
create or replace function public.has_folder_access(p_folder_id text, p_require_editor boolean default false)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from folder_collaborators fc
    join synced_folders sf on sf.id = fc.folder_id
    where fc.folder_id = p_folder_id
      and fc.user_id = auth.uid()
      and fc.left_at is null
      and (not p_require_editor or sf.collab_mode = 'read_write')
  );
$$;

-- 3. synced_folder_items: owner policy rescoped from creator-identity to
--    folder-ownership, so the owner can see/manage every item in their own
--    folder regardless of who created the row (this is the fix itself --
--    do it now, not after a collaborator write goes missing for the owner).
drop policy if exists users_manage_own_synced_folder_items on synced_folder_items;
create policy owners_manage_own_synced_folder_items on synced_folder_items
  for all
  using (folder_owner_id(folder_id) = auth.uid())
  with check (folder_owner_id(folder_id) = auth.uid());

-- 4. synced_folder_items: NEW -- editor-collaborators can write items when
--    the folder's own mode is read_write. Not scoped to the collaborator's
--    own rows on purpose (mirrors editors_manage_shared_equipment) -- an
--    editor on a read_write folder can also edit/delete items someone else
--    (the owner or another collaborator) added, matching the "open collab"
--    framing.
create policy editors_manage_shared_folder_items on synced_folder_items
  for all
  using (has_folder_access(folder_id, true))
  with check (has_folder_access(folder_id, true));

-- collaborators_view_shared_folder_items (read, any mode, unchanged) already
-- covers viewer-level read for both read_only and read_write folders.

-- 5. synced_notes: a note's own row is still owned by whoever created it
--    (unchanged -- users_manage_own_synced_notes stays as-is, so a
--    collaborator creating a brand-new note always succeeds under their own
--    ownership first, same as today).
--
--    NEW gap found on re-review, fixed before any test ran: pre-migration,
--    a collaborator could never insert a synced_folder_items row at all (the
--    old owner-only WITH CHECK blocked it), so "owner can't see a
--    collaborator's note" was never reachable in production. This migration
--    is what first lets a collaborator attach a note to someone else's
--    folder -- which means the FOLDER OWNER now needs its own folder-
--    ownership-scoped path into synced_notes too, same shape as items,
--    unconditional on collab_mode (the owner always controls their own
--    folder's contents; collab_mode governs collaborators, not the owner).
create policy owners_manage_shared_notes on synced_notes
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
    )
  );

-- 6. synced_notes: editor-collaborators can manage a note already placed in
--    a read_write folder, even when they didn't create it (mirrors #5, but
--    gated by has_folder_access's collab_mode check instead of ownership).
create policy editors_manage_shared_notes on synced_notes
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
    )
  );
