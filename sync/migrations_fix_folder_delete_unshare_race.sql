-- Fix: deleting a shared folder always spurious-errors on unshare -- QA sweep 2026-08-26
--
-- deleteFolder() (src/lib/folders.ts) fires two concurrent, unawaited calls:
-- syncPushFolderDelete (-> soft_delete_own_folder RPC, sets deleted=true) and
-- unshareFolder (a raw client UPDATE clearing synced_folders.share_token +
-- a DELETE on folder_collaborators). Found live during a QA sweep: the raw
-- UPDATE 403s every time it loses the race to the RPC (console error +
-- Sentry report on every folder delete, not just an occasional flake) --
-- root cause is structural, not timing-sensitive luck. folders_own_update's
-- WITH CHECK requires is_folder_visible(id), which only counts rows where
-- deleted = false -- once soft_delete_own_folder sets deleted = true, that
-- folder can NEVER satisfy WITH CHECK again, so any raw UPDATE reaching the
-- row after the soft-delete is guaranteed to fail, every time, not just
-- sometimes. (folder_collaborators' own DELETE succeeds fine -- it has no
-- such WITH CHECK gate -- so the real leftover is only a stray non-null
-- share_token on an already soft-deleted row, not an active leak.)
--
-- Fix: soft_delete_own_folder is already SECURITY DEFINER (bypasses RLS by
-- design, the same reason it can set deleted=true on a row that becomes
-- invisible), so it can safely also clear share_token and drop
-- folder_collaborators in the SAME statement -- no client-side race
-- possible, and it succeeds atomically with the delete itself. The client
-- change (removing the now-redundant unshareFolder call from deleteFolder's
-- flow specifically) ships in the same commit as this migration.
--
-- unshareFolder() itself is UNCHANGED and still used for its other real
-- call site (src/app/(tabs)/saved.tsx's explicit "Stop Sharing" action on a
-- live, non-deleted folder) -- that path isn't racing a soft-delete, so
-- is_folder_visible(id) still correctly evaluates true and the raw UPDATE
-- still works fine there.

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

  delete from folder_collaborators where folder_id = p_id;
end;
$function$;
