-- Fix: deleting a non-empty folder always spurious-errors on the item
-- cleanup -- pre-B36 QA sweep, 2026-08-26
--
-- Sibling of this morning's migrations_fix_folder_delete_unshare_race.sql,
-- same exact bug shape, found by a fresh QA pass re-testing that fix: a
-- second concurrent, unawaited client call in deleteFolder() --
-- syncPushFolderItemDeletes(), a raw UPDATE on synced_folder_items setting
-- deleted=true -- races the SAME soft_delete_own_folder RPC and loses for
-- the SAME structural reason. owners_synced_folder_items_update's WITH
-- CHECK requires is_folder_visible(folder_id), which only counts
-- deleted=false folders -- once the RPC commits the folder's deleted=true,
-- any item-delete UPDATE landing after it is GUARANTEED to fail, not an
-- occasional race. Repro: create a folder, add any item, delete the
-- folder -- console: "[sync] folder item delete failed: new row violates
-- row-level security policy for table synced_folder_items", every time,
-- on any non-empty folder.
--
-- Not data loss -- the local item removal still happens (deleteFolder's
-- own AsyncStorage write isn't gated by this call), and the orphaned
-- remote row can never resurface (mergeFolderItems only pulls items whose
-- folder_id is a currently-known, non-deleted local folder) -- but it's
-- guaranteed Sentry/console noise on a very common action (delete any
-- folder with something in it).
--
-- Fix: same shape as this morning's -- cascade the item soft-delete INTO
-- soft_delete_own_folder itself (already SECURITY DEFINER, bypasses RLS by
-- design), no client-side race possible. Deliberately NOT filtered to
-- items this caller authored -- syncPushFolderItemDeletes' own comment
-- explains why: a folder owner can legitimately remove an item a
-- collaborator added, so once the folder's OWNERSHIP is confirmed by the
-- UPDATE above (only matches a row this caller owns), every item in that
-- folder is fair game regardless of who added it.
--
-- The client change (removing the now-redundant syncPushFolderItemDeletes
-- call from deleteFolder's flow) ships in the same commit as this
-- migration.

CREATE OR REPLACE FUNCTION public.soft_delete_own_folder(p_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update synced_folders
  set deleted = true, share_token = null, updated_at = now()
  where id = p_id and user_id = auth.uid();

  if found then
    update synced_folder_items
    set deleted = true, updated_at = now()
    where folder_id = p_id and deleted = false;

    delete from folder_collaborators where folder_id = p_id;
  end if;
end;
$function$;
