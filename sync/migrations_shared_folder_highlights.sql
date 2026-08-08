-- Lets a folder collaborator read the owner's synced_bookmarks row for any
-- non-note item referenced by a folder they've actively joined (left_at
-- enforced transitively via folder_collaborators' own RLS). Mirrors
-- collaborators_read_shared_notes on synced_notes exactly, just keyed off
-- synced_folder_items.item_id = synced_bookmarks.id instead of item_type =
-- 'note'.
--
-- Needed because a highlight is a BookmarkAC row whose OWN id (not the real
-- document id) is what gets written to synced_folder_items.item_id -- see
-- src/lib/bookmarks.ts's BookmarkAC.id comment. Without this policy, a
-- highlight added to a shared folder was invisible to collaborators: the
-- content-table lookup in resolveForeignFolderEntries/folder/shared/[id].tsx
-- queried e.g. advisory_circulars.id with the highlight's synthetic id,
-- which never matches a real row.
create policy collaborators_read_shared_bookmarks
  on public.synced_bookmarks
  for select
  using (
    exists (
      select 1
      from synced_folder_items sfi
      join folder_collaborators fc on fc.folder_id = sfi.folder_id
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and fc.user_id = auth.uid()
    )
  );
