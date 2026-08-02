-- ============================================================================
-- synced_folder_items: add 'dictionary' to item_type CHECK constraint
-- 2026-08-02
--
-- Found live while verifying "make sure all the connections work with this
-- new area - bookmarks, folder additions, etc." for the new mnemonic
-- content: adding a dictionary/mnemonic entry to a folder wrote correctly to
-- local storage but silently never reached synced_folder_items. A direct
-- REST replay of the exact upsert syncPushFolderItems sends returned
-- Postgres error 23514 -- the CHECK constraint only allowed
-- ('ac','far','aim','pcg','ad','loi','note'), missing 'dictionary' entirely.
--
-- This is the same class of bug as the 2026-07-31 fix noted in
-- flyregs_gotchas.md ("Synced Folder Items CHECK Constraint Gotcha") -- that
-- fix widened the constraint for FAR/AIM/PCG/AD/LOI, but 'dictionary' (added
-- with Aviation Dictionary v1, task #40) was never added to it. Client-side
-- FolderItemType (src/lib/folders.ts) already included 'dictionary' the
-- whole time, so every dictionary-term folder-add since v1 shipped has been
-- failing to sync, not just mnemonics -- and syncPushFolderItems never
-- checks the upsert's returned error, so it failed completely silently (no
-- console error, no thrown exception, nothing).
-- ============================================================================

alter table public.synced_folder_items drop constraint synced_folder_items_item_type_check;

alter table public.synced_folder_items add constraint synced_folder_items_item_type_check
  check (item_type = any (array['ac', 'far', 'aim', 'pcg', 'ad', 'loi', 'note', 'dictionary']));
