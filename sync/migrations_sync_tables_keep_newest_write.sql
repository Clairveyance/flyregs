-- Fixes a real gap confirmed live by the B34 readiness "save/send/share
-- reliability" sweep: synced_notes' upsert has no conflict guard by
-- timestamp, so a chronologically OLDER write that happens to arrive over
-- the network LAST silently overwrites a newer one -- "last-arrival-wins"
-- instead of "last-edit-wins". Every syncPush* call is fire-and-forget
-- (src/lib/syncPush.ts), so two devices editing the same note/bookmark/
-- folder/folder-item around the same time (or one device replaying a
-- delayed retry after being offline) can genuinely race.
--
-- All 4 client-writable sync tables share the identical shape --
-- (user_id, id) upsert conflict target, an updated_at column, pushed via
-- the same fire-and-forget upsert pattern in syncPush.ts -- so this fix
-- applies uniformly to all 4, not just the one the sweep happened to
-- catch first.
--
-- Design: BEFORE UPDATE trigger, fires only on the ON CONFLICT DO UPDATE
-- path an upsert takes for a row that already exists (a plain INSERT of a
-- brand-new id is untouched -- there's no OLD row to lose). If the
-- incoming NEW.updated_at is older than the existing OLD.updated_at, keep
-- OLD instead of applying the stale write. No error is raised -- the
-- upsert call still returns success (this is a merge outcome, not a
-- failure the client needs to react to), it just silently keeps the
-- newer content. A delete is just another write with a fresh
-- updated_at, so it naturally still wins under this same rule without
-- needing special-case logic.

create or replace function public.keep_newest_write()
returns trigger
language plpgsql
as $$
begin
  if NEW.updated_at < OLD.updated_at then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_keep_newest_write on public.synced_notes;
create trigger trg_keep_newest_write
  before update on public.synced_notes
  for each row execute function public.keep_newest_write();

drop trigger if exists trg_keep_newest_write on public.synced_bookmarks;
create trigger trg_keep_newest_write
  before update on public.synced_bookmarks
  for each row execute function public.keep_newest_write();

drop trigger if exists trg_keep_newest_write on public.synced_folders;
create trigger trg_keep_newest_write
  before update on public.synced_folders
  for each row execute function public.keep_newest_write();

drop trigger if exists trg_keep_newest_write on public.synced_folder_items;
create trigger trg_keep_newest_write
  before update on public.synced_folder_items
  for each row execute function public.keep_newest_write();
