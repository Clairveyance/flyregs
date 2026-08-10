-- ============================================================================
-- FIX: collaborator self-escalation via aircraft_collaborators.role /
-- folder_collaborators.collab_mode                                2026-08-10
-- ============================================================================
--
-- Found during a standing RLS-policy audit (ownership/access-control
-- correctness, distinct from the tier-gating and relational-integrity
-- sweeps done earlier the same night).
--
-- BUG: users_mark_own_aircraft_collaboration_viewed and
-- users_mark_own_collaboration_viewed (see migrations_aircraft_sharing.sql
-- and the BB-077 per-invitee collab_mode work) grant a collaborator UPDATE
-- on their OWN aircraft_collaborators/folder_collaborators row via
-- `using (auth.uid() = user_id) with_check (auth.uid() = user_id)`, with no
-- column restriction. Postgres RLS is row-level, not column-level, and
-- multiple permissive policies for the same command are OR'd together -- so
-- a collaborator invited as "viewer" (role) / "read_only" (collab_mode)
-- could issue a raw PostgREST PATCH against their own row setting
-- role='editor' / collab_mode='read_write', since that policy alone was
-- satisfied regardless of which columns actually changed. Those exact
-- columns are what has_aircraft_access()/has_folder_access() gate write
-- access on, so this was a full self-service privilege escalation to
-- editor/read-write on someone else's aircraft/folder.
--
-- Live-tested and confirmed exploitable 2026-08-10 with two disposable
-- @flyregs.invalid accounts (created and fully deleted in the same
-- session, cascade-cleaned): a seeded "viewer" aircraft_collaborators row
-- self-promoted to "editor" with one PATCH, then successfully renamed the
-- owner's aircraft via editors_update_shared_aircraft. Same mechanism
-- confirmed independently for folder_collaborators.collab_mode
-- (read_only -> read_write).
--
-- FIX: a BEFORE UPDATE trigger on each table. Only last_viewed_at may be
-- freely self-updated by the invited collaborator (the policy's original,
-- intended purpose). Any other column change requires either:
--   (a) auth.uid() = owner_id -- the existing direct owner path (e.g.
--       src/lib/sharedFolders.ts's setCollaboratorMode calling
--       folder_collaborators' owners_update_collaborator_mode policy), or
--   (b) execution inside a SECURITY DEFINER function -- current_user is
--       NOT 'authenticated'/'anon' there. Confirmed live that
--       invite_aircraft_collaborator, join_shared_aircraft,
--       invite_folder_collaborator, and join_shared_folder are all owned
--       by `postgres`, so their internal UPDATEs (accept-invite setting
--       accepted_at/left_at from the INVITEE's own session, or the
--       owner-driven role/collab_mode upserts) pass through untouched.
--
-- Verified live, post-fix, all four ways:
--   1. Collaborator re-attempts role/collab_mode self-escalation -> blocked
--      (P0001 "Only last_viewed_at may be self-updated by a collaborator").
--   2. Collaborator's own last_viewed_at self-update -> still works.
--   3. Owner's direct setCollaboratorMode-equivalent update -> still works.
--   4. join_shared_aircraft's ON CONFLICT DO UPDATE branch (a real
--      invitee-driven role change when an owner changes a share code's
--      default role and the same invitee re-redeems it) -> still works,
--      because current_user is 'postgres' inside that RPC.
-- ============================================================================

create or replace function public.guard_aircraft_collaborator_self_update()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new; -- trusted SECURITY DEFINER RPC context (owned by postgres)
  end if;
  if auth.uid() = old.owner_id then
    return new; -- owner acting directly, e.g. a future owner-side role editor
  end if;
  -- Otherwise this is the collaborator themselves via raw PostgREST/direct
  -- client update. Only last_viewed_at may change.
  if new.aircraft_id is distinct from old.aircraft_id
     or new.owner_id is distinct from old.owner_id
     or new.user_id is distinct from old.user_id
     or new.role is distinct from old.role
     or new.invite_token is distinct from old.invite_token
     or new.accepted_at is distinct from old.accepted_at
     or new.left_at is distinct from old.left_at
     or new.joined_at is distinct from old.joined_at
  then
    raise exception 'Only last_viewed_at may be self-updated by a collaborator';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_aircraft_collaborator_self_update on public.aircraft_collaborators;
create trigger trg_guard_aircraft_collaborator_self_update
  before update on public.aircraft_collaborators
  for each row execute function public.guard_aircraft_collaborator_self_update();

create or replace function public.guard_folder_collaborator_self_update()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new; -- trusted SECURITY DEFINER RPC context (owned by postgres)
  end if;
  if auth.uid() = old.owner_id then
    return new; -- owner acting directly, e.g. setCollaboratorMode
  end if;
  if new.folder_id is distinct from old.folder_id
     or new.owner_id is distinct from old.owner_id
     or new.user_id is distinct from old.user_id
     or new.collab_mode is distinct from old.collab_mode
     or new.invite_token is distinct from old.invite_token
     or new.accepted_at is distinct from old.accepted_at
     or new.left_at is distinct from old.left_at
     or new.joined_at is distinct from old.joined_at
  then
    raise exception 'Only last_viewed_at may be self-updated by a collaborator';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_folder_collaborator_self_update on public.folder_collaborators;
create trigger trg_guard_folder_collaborator_self_update
  before update on public.folder_collaborators
  for each row execute function public.guard_folder_collaborator_self_update();
