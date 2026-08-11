-- Every sharing check (aircraft AND folders) only ever verified Premium
-- ONCE, at invite/accept time -- nothing re-checked it for the lifetime of
-- the relationship after that. Live-proven exploitable: Premium owner
-- shares, Premium collaborator accepts, then the OWNER'S Premium lapses
-- (server-side, same JWT, no re-login -- matches a real RevenueCat webhook
-- downgrade) -- the collaborator's read/write access kept working with
-- zero re-check. Directly contradicts RC's own explicit decision
-- (flyregs_decisions.md, "Sharing (aircraft or folders) requires Premium
-- from every party, confirmed 2026-08-10"): that rule was only ever
-- enforced at the door, not continuously.
--
-- Found in the post-build-31 sweep's cross-feature-interaction pass.
--
-- FIRST VERSION OF THIS MIGRATION HAD A REAL BUG, caught by this session's
-- own live re-verification before it ever shipped: the 4 policies that
-- duplicate collaborator-membership checks inline (collaborators_view_
-- shared_folders/_folder_items, collaborators_read_shared_notes/_bookmarks)
-- got a nested `EXISTS (... FROM user_entitlements WHERE user_id =
-- fc.owner_id ...)` added directly in their USING clause -- but
-- user_entitlements' own RLS (user_entitlements_select_own: `auth.uid() =
-- user_id`) means a collaborator's session can only ever see THEIR OWN
-- entitlement row via a plain query, never the owner's. That nested EXISTS
-- silently evaluated to false for every legitimate collaborator too,
-- breaking real access, not just the exploit. has_folder_access()/
-- has_aircraft_access() are SECURITY DEFINER specifically to bypass this
-- exact problem -- they run with the function owner's privileges, so a
-- nested user_entitlements check inside them isn't subject to the
-- caller's own RLS. The fix: stop duplicating the check inline in these 4
-- policies at all -- delegate to has_folder_access() like editors_manage_*
-- already correctly does, rather than re-deriving the same logic a second,
-- RLS-broken way. One correct implementation, called from every policy,
-- instead of two.

-- 1. has_folder_access() -- fixes editors_manage_shared_folder_items,
--    editors_manage_shared_notes, editors_manage_shared_bookmarks for free
--    (they already delegate here). SECURITY DEFINER means the nested
--    user_entitlements checks below run without being subject to the
--    caller's own RLS on that table.
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
      and exists (select 1 from user_entitlements ue where ue.user_id = fc.user_id and ue.is_premium = true)
      and exists (select 1 from user_entitlements ue where ue.user_id = fc.owner_id and ue.is_premium = true)
  );
$function$;

-- 2. has_aircraft_access() -- fixes collaborators_view_shared_aircraft,
--    editors_update_shared_aircraft, collaborators_view_shared_equipment,
--    editors_manage_shared_equipment for free (all already delegate here).
CREATE OR REPLACE FUNCTION public.has_aircraft_access(p_aircraft_id uuid, p_require_editor boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from aircraft_collaborators ac
    where ac.aircraft_id = p_aircraft_id
      and ac.user_id = auth.uid()
      and ac.left_at is null
      and ac.accepted_at is not null
      and (not p_require_editor or ac.role = 'editor')
      and exists (select 1 from user_entitlements ue where ue.user_id = ac.user_id and ue.is_premium = true)
      and exists (select 1 from user_entitlements ue where ue.user_id = ac.owner_id and ue.is_premium = true)
  );
$function$;

-- 3. collaborators_view_shared_folders (SELECT on synced_folders) -- was an
--    inline duplicate of has_folder_access's own membership check; now
--    just calls it directly with the row's own id.
DROP POLICY IF EXISTS collaborators_view_shared_folders ON public.synced_folders;
CREATE POLICY collaborators_view_shared_folders ON public.synced_folders
  FOR SELECT
  USING (has_folder_access(id));

-- 4. collaborators_view_shared_folder_items (SELECT on synced_folder_items)
DROP POLICY IF EXISTS collaborators_view_shared_folder_items ON public.synced_folder_items;
CREATE POLICY collaborators_view_shared_folder_items ON public.synced_folder_items
  FOR SELECT
  USING (has_folder_access(folder_id));

-- 5. collaborators_read_shared_notes (SELECT on synced_notes) -- same
--    delegation, threaded through the synced_folder_items join since
--    synced_notes itself has no folder_id column.
DROP POLICY IF EXISTS collaborators_read_shared_notes ON public.synced_notes;
CREATE POLICY collaborators_read_shared_notes ON public.synced_notes
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM synced_folder_items sfi
    WHERE sfi.item_type = 'note'
      AND sfi.item_id = synced_notes.id
      AND sfi.deleted = false
      AND has_folder_access(sfi.folder_id)
  ));

-- 6. collaborators_read_shared_bookmarks (SELECT on synced_bookmarks) --
--    same delegation. Supersedes this same session's earlier
--    migrations_fix_bookmarks_pending_invite_defense_in_depth.sql, which
--    hardened accepted_at/left_at inline but (written before this fix)
--    didn't yet know to delegate for the entitlement check too.
DROP POLICY IF EXISTS collaborators_read_shared_bookmarks ON public.synced_bookmarks;
CREATE POLICY collaborators_read_shared_bookmarks ON public.synced_bookmarks
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM synced_folder_items sfi
    WHERE sfi.item_type <> 'note'
      AND sfi.item_id = synced_bookmarks.id
      AND sfi.deleted = false
      AND has_folder_access(sfi.folder_id)
  ));
