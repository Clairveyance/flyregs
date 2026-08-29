-- RC (2026-08-29, live joint testing): "When I added a new note to a
-- shared folder, it populated that same note and essentially duplicated it
-- four times." Confirmed the only non-atomic write path onto
-- synced_folder_items: addExistingItemToSharedFolder (src/lib/
-- sharedFolders.ts) does a SELECT-then-INSERT ("does an active row for this
-- (folder_id, item_type, item_id) already exist? if not, insert") with no
-- DB-level constraint backing it -- a genuine TOCTOU race under a rapid
-- double-tap or a client retry, since each generated row gets its own
-- fresh client-side id (makeItemId()), so even an upsert keyed on id
-- wouldn't have deduplicated.
--
-- Confirmed zero existing violations before adding this (checked live: a
-- GROUP BY (folder_id, item_type, item_id) WHERE deleted = false HAVING
-- count(*) > 1 returned no rows), so this is safe to add as a real
-- constraint rather than a soft app-level check. Partial (WHERE deleted =
-- false) rather than a plain unique index -- re-adding a since-removed item
-- (a real, common flow: remove, then add it back) must still work; only
-- currently-ACTIVE duplicates are the actual bug.
create unique index if not exists idx_synced_folder_items_unique_active
  on public.synced_folder_items (folder_id, item_type, item_id)
  where deleted = false;
