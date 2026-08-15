-- Extends synced_folder_items' item_type CHECK to accept 'cfr49', matching
-- the client-side FolderItemType union (src/lib/folders.ts) now that
-- cfr49/[id].tsx supports "Add to Folder" like every other reg type.
-- bookmarks/highlights/downloads/document_citations have no DB-level type
-- CHECK at all (confirmed via pg_constraint) so only this table needed it.
ALTER TABLE public.synced_folder_items DROP CONSTRAINT synced_folder_items_item_type_check;
ALTER TABLE public.synced_folder_items ADD CONSTRAINT synced_folder_items_item_type_check
  CHECK (item_type = ANY (ARRAY['ac'::text, 'far'::text, 'aim'::text, 'pcg'::text, 'ad'::text, 'loi'::text, 'note'::text, 'dictionary'::text, 'cfr49'::text]));
