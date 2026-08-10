-- ============================================================================
-- Mutual editing for bookmarks in read/write shared folders          2026-08-10
-- ============================================================================
--
-- Flagged during the 2026-08-10 RLS policy audit: synced_bookmarks had no
-- owner/editor write policy analogous to synced_notes' own
-- editors_manage_shared_notes/owners_manage_shared_notes -- only a
-- bookmark's original creator could edit/delete its content row
-- (users_manage_own_synced_bookmarks: auth.uid() = user_id), even when that
-- exact bookmark was placed into someone else's shared folder. The folder
-- owner/editor could freely add/remove the LINK (synced_folder_items,
-- already correctly gated by has_folder_access) but never touch the
-- bookmark's own content.
--
-- Confirmed by inspection this is a real, live gap: every regulation-type
-- synced_folder_items row (item_type IN ac/far/aim/pcg/ad/loi/dictionary)
-- has item_id pointing directly at a synced_bookmarks.id row, NOT at the
-- regulation table itself -- i.e. every "AC/FAR/etc in a folder" IS a
-- bookmark row under the hood. Only 'note' items point elsewhere (at
-- synced_notes.id), which is why synced_notes already had this exact
-- pattern and synced_bookmarks didn't.
--
-- RC's answer, asked directly: "yes both people should be able to edit the
-- other's bookmarks, work, additions, etc, BUT only IF it a collab, r/w
-- folder between them. If things are truly shared and r/w for all, then
-- yes, all editing/changes are allowed." -- i.e. mirror synced_notes'
-- existing behavior exactly: read_write collaborators AND the owner can
-- both edit/delete ANY bookmark linked into that shared folder, regardless
-- of who originally created it; read_only collaborators still cannot
-- (has_folder_access's own p_require_editor=true gate already handles
-- that distinction, unchanged).
-- ============================================================================

drop policy if exists editors_manage_shared_bookmarks on public.synced_bookmarks;
create policy editors_manage_shared_bookmarks on public.synced_bookmarks
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
    )
  );

drop policy if exists owners_manage_shared_bookmarks on public.synced_bookmarks;
create policy owners_manage_shared_bookmarks on public.synced_bookmarks
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
    )
  );
