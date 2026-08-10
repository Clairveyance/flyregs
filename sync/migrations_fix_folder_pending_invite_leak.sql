-- Fix: a Callsign-invited folder collaborator (folder_collaborators.accepted_at
-- still NULL, invite not yet accepted) had full read/write access to the
-- folder, its items, and its shared notes -- before ever calling
-- join_shared_folder. This is a reintroduction of the exact bug already found
-- and fixed for aircraft sharing (2026-08-09, has_aircraft_access ->
-- "and accepted_at is not null") -- the folder Callsign-invite feature
-- (2026-08-09, "matching aircraft sharing") was built on has_folder_access(),
-- which never got the equivalent clause, and 3 sibling policies duplicate the
-- same unguarded check inline instead of delegating to the function.
--
-- Found+live-proven via the 2026-08-10 full-app consistency/regression-shape
-- sweep (two disposable accounts, invitee read+wrote before accepting).
--
-- The plain link-invite path (join_shared_folder) is unaffected -- its insert
-- sets accepted_at = now() atomically in the same statement that creates the
-- row, so there's never a real gap for that path.

-- 1. has_folder_access() -- covers editors_manage_shared_folder_items (ALL)
--    and editors_manage_shared_notes (ALL) in one fix, same as the aircraft case.
CREATE OR REPLACE FUNCTION public.has_folder_access(p_folder_id text, p_require_editor boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from folder_collaborators fc
    where fc.folder_id = p_folder_id
      and fc.user_id = auth.uid()
      and fc.left_at is null
      and fc.accepted_at is not null
      and (not p_require_editor or fc.collab_mode = 'read_write')
  );
$function$;

-- 2. collaborators_view_shared_folders (SELECT on synced_folders)
DROP POLICY IF EXISTS collaborators_view_shared_folders ON public.synced_folders;
CREATE POLICY collaborators_view_shared_folders ON public.synced_folders
  FOR SELECT
  USING (id IN (
    SELECT fc.folder_id FROM folder_collaborators fc
    WHERE fc.user_id = auth.uid() AND fc.left_at IS NULL AND fc.accepted_at IS NOT NULL
  ));

-- 3. collaborators_view_shared_folder_items (SELECT on synced_folder_items)
DROP POLICY IF EXISTS collaborators_view_shared_folder_items ON public.synced_folder_items;
CREATE POLICY collaborators_view_shared_folder_items ON public.synced_folder_items
  FOR SELECT
  USING (folder_id IN (
    SELECT fc.folder_id FROM folder_collaborators fc
    WHERE fc.user_id = auth.uid() AND fc.left_at IS NULL AND fc.accepted_at IS NOT NULL
  ));

-- 4. collaborators_read_shared_notes (SELECT on synced_notes) -- previously
--    missing BOTH left_at and accepted_at checks, the worst of the four.
DROP POLICY IF EXISTS collaborators_read_shared_notes ON public.synced_notes;
CREATE POLICY collaborators_read_shared_notes ON public.synced_notes
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM synced_folder_items sfi
    JOIN folder_collaborators fc ON fc.folder_id = sfi.folder_id
    WHERE sfi.item_type = 'note'
      AND sfi.item_id = synced_notes.id
      AND sfi.deleted = false
      AND fc.user_id = auth.uid()
      AND fc.left_at IS NULL
      AND fc.accepted_at IS NOT NULL
  ));
