-- Fixes P0-3 from the 2026-08-22 gating audit: a folder pushed over the
-- visibility cap by a downgrade can never be promoted back into view or
-- deleted through the normal client path. Confirmed live: Premium
-- account with 5 folders downgraded to Pro (cap 3) -- promoting a hidden
-- folder's sort_order, and soft-deleting one (the real client operation,
-- `deleted = true` via UPDATE, not a hard DELETE), both silently affect
-- 0 rows despite returning 200.
--
-- Root cause: same underlying Postgres RLS principle as the aircraft fix
-- (get_owned_aircraft_oldest_first/keep_only_aircraft, this same session)
-- -- UPDATE requires SELECT-policy visibility as a precondition to even
-- find the row, regardless of what the UPDATE policy's own USING clause
-- says. folders_own_select requires is_folder_visible_row(...); a hidden
-- folder never satisfies it, so it can never be found to update at all --
-- not a rename, not a reorder, not the soft-delete UPDATE. The on-screen
-- instruction ("drag the 3 you want to the top") is consequently
-- impossible to follow: promoting a hidden folder requires updating ITS
-- OWN sort_order, the exact operation this blocks.
--
-- Fix: two narrow SECURITY DEFINER RPCs, scoped internally by auth.uid()
-- (never trusting a client-supplied user id), for this legitimate
-- recovery flow only -- the general folders_own_select/update policies
-- are untouched, so no general read/write bypass is reopened.
create or replace function public.get_owned_folders_all()
 returns table(id text, name text, sort_order integer, share_token text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select id, name, sort_order, share_token
  from synced_folders
  where user_id = auth.uid() and deleted = false
  order by coalesce(sort_order, 2147483647) asc, created_at asc, id asc;
$function$;

grant execute on function public.get_owned_folders_all() to authenticated;

-- p_ids/p_sort_orders are parallel arrays (id -> its new sort_order),
-- matching how reorderFolders() already builds a full ordered list
-- client-side -- this just gives it a path that can move a currently
-- HIDDEN folder into visible range, which the normal upsert path cannot
-- (WITH CHECK on folders_own_update requires is_folder_visible(id),
-- evaluated against a same-statement self-lookup this project has
-- already been burned by trusting once -- deliberately not routed
-- through that path again here).
create or replace function public.set_folder_sort_orders(p_ids text[], p_sort_orders integer[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if array_length(p_ids, 1) is distinct from array_length(p_sort_orders, 1) then
    raise exception 'p_ids and p_sort_orders must be the same length';
  end if;
  update synced_folders sf
  set sort_order = v.sort_order, updated_at = now()
  from (select unnest(p_ids) as id, unnest(p_sort_orders) as sort_order) v
  where sf.id = v.id and sf.user_id = auth.uid();
end;
$function$;

grant execute on function public.set_folder_sort_orders(text[], integer[]) to authenticated;

-- Soft-delete (deleted = true), matching the real client path
-- (syncPushFolderDelete) -- not a hard delete, so folder_items/collab
-- cleanup that already runs on delete elsewhere is unaffected, this only
-- unblocks the one UPDATE that was silently failing.
create or replace function public.soft_delete_own_folder(p_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update synced_folders
  set deleted = true, updated_at = now()
  where id = p_id and user_id = auth.uid();
end;
$function$;

grant execute on function public.soft_delete_own_folder(text) to authenticated;
