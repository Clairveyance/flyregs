-- Found by the 2026-08-14 night-rules tier-gate audit agent, live-
-- reproduced end-to-end with a real throwaway account before being
-- flagged (not applied by the agent itself, since it's an RLS change on
-- shared production schema -- reviewed and applied here after confirming
-- scope directly against the live has_folder_access()/folder_visible_cap()
-- definitions).
--
-- The 2026-08-11/12 downgrade-retention fixes (see
-- migrations_fix_downgrade_retains_over_cap_data.sql,
-- migrations_folder_cap_server_backstop.sql) correctly cap-gated
-- user_aircraft/synced_folders UPDATE via has_visible_fleet_access()/
-- has_visible_folder_access() -- a downgraded user can no longer rename an
-- over-cap "locked" folder. But the CHILD table, synced_folder_items (the
-- actual bookmarked items *inside* a folder), was never extended the same
-- way -- owners_manage_own_synced_folder_items is a bare ownership check
-- with no cap awareness at all.
--
-- Live-reproduced: Premium account creates 4 folders (cap=unlimited), adds
-- an item to the 4th, downgrades to Pro (cap=3) -- saved.tsx correctly
-- hides folder #4, renaming it correctly 403s (the already-fixed row-level
-- policy), but INSERTing a new item into folder #4 via
-- synced_folder_items still succeeds (201), and it's not just a REST-
-- bypass theoretical: FolderPicker.tsx lists ALL folders unfiltered as
-- Add-to-Folder destinations with no cap check, so a downgraded user sees
-- their "locked" folder as a normal tappable target from any document and
-- can keep adding items to it through completely ordinary use.
--
-- Fix mirrors the exact, already-proven user_aircraft_reminders pattern:
-- SELECT/DELETE stay untouched (a downgraded user can still see and clean
-- up items in a locked folder, same "don't block cleanup" reasoning as
-- reminders' own comment), INSERT/UPDATE gain
-- has_visible_folder_access().
--
-- editors_manage_shared_folder_items (the COLLABORATOR path) was checked
-- and deliberately left alone, same "nothing to gate" reasoning as
-- user_aircraft_equipment's own note in the reminders migration:
-- has_folder_access() requires BOTH parties to be_premium=true, and
-- Premium's folder_visible_cap() is always unlimited -- a shared folder
-- can never legitimately be over-cap for either party, so there is no
-- scenario for this policy to gate.
--
-- KNOWN LIMITATION, live-discovered while verifying THIS fix, not
-- introduced by it -- has_visible_folder_access() is a blunt aggregate
-- check (total folder count <= cap), not a per-folder one. The client's
-- own "which folders are visible" logic ((tabs)/saved.tsx's
-- `folders.slice(0, folderCap)`, sorted by sort_order) is per-folder --
-- the first N are visible/usable, the rest locked. So the moment a
-- downgraded user has ANY folder over cap, this WITH CHECK blocks writes
-- to EVERY folder's items, including the ones that should still be fully
-- usable, not just the locked one -- live-confirmed: inserting into an
-- in-cap folder 403'd right alongside the over-cap one. The EXACT same
-- gap already existed in the already-shipped, already-verified
-- synced_folders UPDATE policy (folders_own_update, same
-- has_visible_folder_access() call) and in user_aircraft_reminders'
-- has_visible_fleet_access() -- this migration doesn't introduce the
-- imprecision, it inherits the existing function's own shape faithfully.
-- Fail-CLOSED (blocks legitimate in-cap actions), not fail-open (never
-- allows an over-cap write) -- the safer direction for a first pass, but
-- a real UX correctness bug for any downgraded user with more than one
-- extra folder/aircraft. Flagged in PROJECT_NOTES/flyregs_pending.md
-- (2026-08-14) for a dedicated fix: has_visible_folder_access()/
-- has_visible_fleet_access() need to become per-row (rank by sort_order/
-- created_at against the row's own id, not a bare count), across all 3
-- policies this shape touches, not patched here in isolation.
DROP POLICY IF EXISTS owners_manage_own_synced_folder_items ON public.synced_folder_items;

CREATE POLICY owners_synced_folder_items_select ON public.synced_folder_items
  FOR SELECT USING (folder_owner_id(folder_id) = auth.uid());

CREATE POLICY owners_synced_folder_items_delete ON public.synced_folder_items
  FOR DELETE USING (folder_owner_id(folder_id) = auth.uid());

CREATE POLICY owners_synced_folder_items_insert ON public.synced_folder_items
  FOR INSERT WITH CHECK (
    folder_owner_id(folder_id) = auth.uid()
    AND public.has_visible_folder_access()
  );

CREATE POLICY owners_synced_folder_items_update ON public.synced_folder_items
  FOR UPDATE
  USING (folder_owner_id(folder_id) = auth.uid())
  WITH CHECK (
    folder_owner_id(folder_id) = auth.uid()
    AND public.has_visible_folder_access()
  );
