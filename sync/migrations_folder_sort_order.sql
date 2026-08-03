-- Adds a persisted display order to synced_folders, for the tap-and-drag
-- Folders reorder feature (RC: "can we build a tap and drag to reorder
-- feature for Folders?"). Folders previously had no order column at all --
-- getFolders() just returned AsyncStorage's array as-is, which happened to
-- equal creation order since createFolder() always appended.
alter table public.synced_folders add column if not exists sort_order integer;

-- Backfill existing rows so the reorder feature's baseline matches what
-- users already see today (creation order), not an arbitrary DB row order.
with ranked as (
  select id, row_number() over (partition by user_id order by created_at) - 1 as rn
  from public.synced_folders
  where sort_order is null
)
update public.synced_folders sf
set sort_order = ranked.rn
from ranked
where sf.id = ranked.id;
