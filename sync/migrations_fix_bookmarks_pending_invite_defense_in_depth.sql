-- collaborators_read_shared_bookmarks (synced_bookmarks) was the one
-- policy the 2026-08-10 pending-invite-leak sweep (see
-- migrations_fix_folder_pending_invite_leak.sql) missed -- it never
-- checked fc.accepted_at/fc.left_at directly. It has NOT been exploitable:
-- live-tested both directions (pending-invite, left-collaborator) and both
-- correctly returned zero rows, because its EXISTS subquery joins
-- synced_folder_items, and that table's own RLS (collaborators_view_shared_
-- folder_items) already enforces both checks -- Postgres RLS applies to
-- every table referenced inside another policy's expression, not just the
-- top-level queried table, so a pending/left collaborator's synced_folder_items
-- rows are invisible regardless of what this policy itself checks.
--
-- Fixing anyway: this safety is implicit and undocumented -- it depends on
-- nobody ever loosening synced_folder_items's own policy without realizing
-- synced_bookmarks silently depends on it, and it's inconsistent with every
-- sibling policy (collaborators_read_shared_notes, collaborators_view_
-- shared_folders/folder_items) encoding the check explicitly. synced_bookmarks
-- holds real saved regulation excerpts (block_text/block_snippet), not just
-- pointers. Found during the post-build-31 sweep's independent security
-- re-audit; the exact same live-account exploit test (pending-invite read,
-- left-collaborator read) was re-run after this change to confirm it stays
-- blocked -- not just that it doesn't newly break anything.
DROP POLICY IF EXISTS collaborators_read_shared_bookmarks ON public.synced_bookmarks;
CREATE POLICY collaborators_read_shared_bookmarks ON public.synced_bookmarks
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM synced_folder_items sfi
    JOIN folder_collaborators fc ON fc.folder_id = sfi.folder_id
    WHERE sfi.item_type <> 'note'
      AND sfi.item_id = synced_bookmarks.id
      AND sfi.deleted = false
      AND fc.user_id = auth.uid()
      AND fc.left_at IS NULL
      AND fc.accepted_at IS NOT NULL
  ));
