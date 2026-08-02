-- ============================================================================
-- Shared-folder RLS holes  --  2026-07-31
-- Both found by scripts/folders_e2e_test.py + a targeted probe, with three
-- real accounts. Both are confirmed by observed behaviour, not by reading.
--
-- HOLE 1 — ITEM INJECTION INTO SOMEONE ELSE'S FOLDER
--   users_manage_own_synced_folder_items had
--       WITH CHECK (auth.uid() = user_id)
--   and nothing about folder_id. So ANY authenticated user could insert a
--   row naming ANY folder_id, as long as user_id was their own. Observed:
--       stranger INSERT into an unrelated shared folder -> HTTP 201
--       legitimate collaborator sees the injected item  -> TRUE
--       folder OWNER sees the injected item             -> FALSE
--   The owner cannot see it (their SELECT is user_id-scoped) and therefore
--   cannot delete it, while every collaborator can. Undeletable,
--   owner-invisible content injected into a shared study folder.
--
--   The fix must NOT require the folder row to already exist: sync.ts's
--   pushAllUp() fires syncPushFolder() and syncPushFolderItems() inside one
--   Promise.all, so an item legitimately races ahead of its folder. Phrased
--   as "no OTHER user owns this folder_id", which blocks the attack and is
--   indifferent to push order.
--
-- HOLE 2 — LEAVING A SHARED FOLDER REVOKED NOTHING
--   leaveSharedFolder() sets folder_collaborators.left_at, but neither
--   collaborator SELECT policy looked at left_at (0 policies referenced the
--   column). Observed after leaving:
--       ex-collaborator can still read items  -> TRUE (2 rows)
--       ex-collaborator can still read folder -> TRUE ("RLS probe")
--   Access was permanent. The owner's collaborator list filters on left_at,
--   so the owner believes the person is gone.
-- ============================================================================

-- ---------------------------------------------------------------- HOLE 1
drop policy if exists users_manage_own_synced_folder_items on public.synced_folder_items;
create policy users_manage_own_synced_folder_items
  on public.synced_folder_items
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and not exists (
      select 1 from public.synced_folders f
      where f.id = synced_folder_items.folder_id
        and f.user_id <> auth.uid()
    )
  );

-- ---------------------------------------------------------------- HOLE 2
drop policy if exists collaborators_view_shared_folder_items on public.synced_folder_items;
create policy collaborators_view_shared_folder_items
  on public.synced_folder_items
  for select
  using (
    folder_id in (
      select fc.folder_id from public.folder_collaborators fc
      where fc.user_id = auth.uid() and fc.left_at is null
    )
  );

drop policy if exists collaborators_view_shared_folders on public.synced_folders;
create policy collaborators_view_shared_folders
  on public.synced_folders
  for select
  using (
    id in (
      select fc.folder_id from public.folder_collaborators fc
      where fc.user_id = auth.uid() and fc.left_at is null
    )
  );

-- ---------------------------------------------------------------- HOLE 1, take 2
-- The first attempt still let the injection through (observed: HTTP 201
-- again). Reason: a subquery inside a POLICY is evaluated with the CALLER's
-- privileges, so RLS applied to it too -- the stranger cannot SELECT the
-- owner's synced_folders row, the subquery returned nothing, and
-- `not exists (...)` was therefore trivially true. Classic RLS-inside-RLS
-- trap: the policy could only see what the attacker could see.
--
-- folder_owner_id() is SECURITY DEFINER, so it answers truthfully regardless
-- of who is asking. NULL means "no such folder yet", which coalesces to the
-- caller and keeps the concurrent folder/item push in sync.ts working.
create or replace function public.folder_owner_id(p_folder_id text)
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  select user_id from synced_folders where id = p_folder_id;
$function$;

revoke all on function public.folder_owner_id(text) from public;
grant execute on function public.folder_owner_id(text) to authenticated;

drop policy if exists users_manage_own_synced_folder_items on public.synced_folder_items;
create policy users_manage_own_synced_folder_items
  on public.synced_folder_items
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and coalesce(public.folder_owner_id(folder_id), auth.uid()) = auth.uid()
  );
