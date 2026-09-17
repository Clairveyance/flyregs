-- Removing a collaborator must END their access without ERASING them.
--
-- RC, 2026-09-17, naming sharing as the app's worst pain area: "Way of adding
-- r/w perms, removing them, how bookmarks and folders and highlights respond
-- to those perms, where they stay or go depending on who sent them and what
-- perms exist between the group."
--
-- scripts/folder_collaborator_removal_test.py found two defects, both caused
-- by the SAME line: removeCollaborator() (sharedFolders.ts, aircraftSharing.ts)
-- hard-DELETEs the membership row. Leaving does not -- leaveSharedFolder soft-
-- marks left_at -- so every guarantee that holds when someone LEAVES silently
-- failed when the owner REMOVED them instead.
--
-- DEFECT 1 -- the owner loses the removed person's work.
--   synced_notes' and synced_bookmarks' owner-read policies are gated on
--   is_folder_participant(folder_id, <author>), which asks whether a
--   folder_collaborators row with accepted_at exists. Delete the row and the
--   answer flips to false: the owner's own folder still LISTS the guest's note
--   and highlight (synced_folder_items survives, it is the owner's folder)
--   but the note body and highlight text become unreadable to them. Notes and
--   highlights a student left behind turn into dead entries in the CFI's
--   folder the moment the CFI removes them. is_folder_participant deliberately
--   ignores left_at for exactly this reason -- which is why the LEAVING path
--   never showed the bug, and why folder_collab_matrix_test passes.
--
-- DEFECT 2 -- removal is a privilege UPGRADE.
--   Both join RPCs INSERT ... ON CONFLICT DO UPDATE. The ON CONFLICT branch
--   deliberately does not overwrite the per-person role, so an existing
--   collaborator re-tapping a link keeps the role they were given. But a
--   REMOVED person has no row, so it is not a conflict -- it is a fresh INSERT
--   at the share link's DEFAULT role. And removal only retires that link when
--   the removed person had no personal invite_token, so for anyone invited by
--   Callsign the link stays live by design. Net effect, proven live:
--     folders  -- downgraded to read_only, removed, walks back in read_write
--     aircraft -- demoted to viewer,      removed, walks back in EDITOR,
--                 with write access to maintenance and AD compliance records
--   Removing someone gave them MORE access than merely demoting them did.
--
-- THE FIX, one shape for both defects: removal becomes SOFT, like leaving.
-- The row stays as a tombstone (left_at set, so access ends on the very next
-- request via has_folder_access / has_aircraft_access, which both already
-- filter it) plus a new removed_at, which is what tells "the owner removed me"
-- apart from "I left". Leaving still permits a re-join with the same link;
-- being removed does not, until the owner issues a fresh invite.
--
-- The database was already built for this. guard_folder_collaborator_self_update's
-- own comment reads: "The OWNER may change only what sharedFolders.ts actually
-- writes as owner: collab_mode (setCollaboratorMode) and left_at
-- (removeCollaborator)." The server expected a soft removal; the client never
-- made the switch.
--
-- Nothing else sees the tombstone. Every other reader of these tables already
-- filters left_at is null (has_folder_access, has_aircraft_access,
-- get_my_collaborations, get_fleet_summary, get_my_shared_aircraft, the paywall
-- counts, both invite RPCs...) -- verified function by function before writing
-- this. The two that do not are is_folder_participant, where it is the point,
-- and get_folder_collaborators, handled below.

begin;

alter table folder_collaborators   add column if not exists removed_at timestamptz;
alter table aircraft_collaborators add column if not exists removed_at timestamptz;

-- ── 1. The owner's roster hides removed people ──────────────────────────────
-- folder/[id].tsx splits this list into active members and a "LEFT THE FOLDER"
-- section. A soft-removed person would land in that section, telling the owner
-- someone left when in fact the owner removed them. They are dropped here
-- instead of given a third section: from the owner's seat the person is gone,
-- which is exactly what the list showed before this migration.
create or replace function public.get_folder_collaborators(p_folder_id text)
returns table(out_user_id uuid, out_display_label text, out_joined_at timestamptz,
              out_left_at timestamptz, out_last_viewed_at timestamptz,
              out_collab_mode text, out_accepted boolean)
language plpgsql security definer set search_path to 'public'
as $$
begin
  -- Not the owner (or the folder is gone, or has not synced yet): nothing to
  -- show. Returning rather than raising -- see migrations_collab_roster_no_raise.
  if not exists (select 1 from synced_folders where id = p_folder_id and user_id = auth.uid()) then
    return;
  end if;

  return query
    select
      fc.user_id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at,
      fc.collab_mode,
      (fc.accepted_at is not null)
    from folder_collaborators fc
    join auth.users u on u.id = fc.user_id
    left join callsign_registry cr on cr.user_id = fc.user_id
    where fc.folder_id = p_folder_id
      and fc.removed_at is null;
end;
$$;

-- ── 2. A removed person cannot re-join on the old link ──────────────────────
create or replace function public.join_shared_folder(p_token text)
returns table(out_folder_id text, out_folder_name text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_folder record;
  v_invite record;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Folder sharing requires Premium';
  end if;

  select fc.* into v_invite from folder_collaborators fc where fc.invite_token = p_token;
  if found then
    if v_invite.user_id <> auth.uid() then
      raise exception 'This invite was sent to a different FlyRegs account';
    end if;
    if v_invite.removed_at is not null then
      raise exception 'The owner removed you from this folder. Ask them to invite you again.';
    end if;
    if v_invite.accepted_at is not null then
      raise exception 'This invite has already been accepted';
    end if;

    update folder_collaborators set accepted_at = now(), left_at = null
      where folder_id = v_invite.folder_id and user_id = auth.uid();

    select id, name into v_folder from synced_folders where id = v_invite.folder_id;
    return query select v_folder.id, v_folder.name;
    return;
  end if;

  select id, name, user_id, collab_mode into v_folder from synced_folders where share_token = p_token and deleted = false;
  if not found then
    raise exception 'Invalid or expired invite link';
  end if;
  if v_folder.user_id = auth.uid() then
    raise exception 'You already own this folder';
  end if;

  -- The folder-wide link stays live after a targeted invitee is removed (the
  -- owner may still be circulating it to other people), so this is the check
  -- that stops the removed person from using it. A raise, not a silent no-op:
  -- this is a write the UI surfaces, and the user needs to know why.
  if exists (select 1 from folder_collaborators fc
              where fc.folder_id = v_folder.id and fc.user_id = auth.uid()
                and fc.removed_at is not null) then
    raise exception 'The owner removed you from this folder. Ask them to invite you again.';
  end if;

  insert into folder_collaborators (folder_id, owner_id, user_id, collab_mode, accepted_at)
  values (v_folder.id, v_folder.user_id, auth.uid(), v_folder.collab_mode, now())
  on conflict (folder_id, user_id) do update set left_at = null, accepted_at = now();
  return query select v_folder.id, v_folder.name;
end;
$$;

create or replace function public.join_shared_aircraft(p_code text)
returns table(out_aircraft_id uuid, out_nickname text, out_make text, out_model text, out_role text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_aircraft record;
  v_invite record;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Aircraft sharing requires Premium';
  end if;

  select ac.* into v_invite from aircraft_collaborators ac where ac.invite_token = p_code;
  if found then
    if v_invite.user_id <> auth.uid() then
      raise exception 'This invite was sent to a different FlyRegs account';
    end if;
    if v_invite.removed_at is not null then
      raise exception 'The owner removed you from this aircraft. Ask them to invite you again.';
    end if;
    if v_invite.accepted_at is not null then
      raise exception 'This invite has already been accepted';
    end if;

    update aircraft_collaborators set accepted_at = now(), left_at = null
      where aircraft_id = v_invite.aircraft_id and user_id = auth.uid();

    select id, nickname, make, model into v_aircraft from user_aircraft where id = v_invite.aircraft_id;
    return query select v_aircraft.id, v_aircraft.nickname, v_aircraft.make, v_aircraft.model, v_invite.role;
    return;
  end if;

  select id, user_id, nickname, make, model, share_code_role
  into v_aircraft
  from user_aircraft
  where share_code = p_code;

  if not found then
    raise exception 'Invalid or expired invite code';
  end if;

  if v_aircraft.user_id = auth.uid() then
    raise exception 'This is your own aircraft';
  end if;

  if exists (select 1 from aircraft_collaborators ac
              where ac.aircraft_id = v_aircraft.id and ac.user_id = auth.uid()
                and ac.removed_at is not null) then
    raise exception 'The owner removed you from this aircraft. Ask them to invite you again.';
  end if;

  insert into aircraft_collaborators (aircraft_id, owner_id, user_id, role, joined_at, accepted_at)
  values (v_aircraft.id, v_aircraft.user_id, auth.uid(), v_aircraft.share_code_role, now(), now())
  on conflict (aircraft_id, user_id) do update
    set role = excluded.role, left_at = null, joined_at = now(), accepted_at = now();

  return query select v_aircraft.id, v_aircraft.nickname, v_aircraft.make, v_aircraft.model, v_aircraft.share_code_role;
end;
$$;

-- ── 3. ...but the owner can always invite them back ─────────────────────────
-- Both invite RPCs already revive a departed row (left_at = null on conflict).
-- They must clear removed_at the same way, or "Remove" would be permanent and
-- an owner who removed someone by mistake could never undo it.
create or replace function public.invite_folder_collaborator(p_folder_id text, p_callsign text, p_token text)
returns table(out_token text, out_user_id uuid, out_callsign text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_folder record;
  v_target_user uuid;
  v_target_callsign text;
  v_existing record;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Folder sharing requires Premium';
  end if;

  select id, collab_mode into v_folder from synced_folders
    where id = p_folder_id and user_id = auth.uid() and deleted = false;
  if not found then
    raise exception 'Not authorized';
  end if;

  select cr.user_id, cr.callsign into v_target_user, v_target_callsign
  from callsign_registry cr where cr.callsign_lower = lower(trim(p_callsign));

  if v_target_user is null then
    raise exception 'No FlyRegs user found with that Callsign';
  end if;

  if v_target_user = auth.uid() then
    raise exception 'You can''t invite yourself';
  end if;

  select * into v_existing from folder_collaborators
    where folder_id = p_folder_id and user_id = v_target_user and left_at is null;

  if found and v_existing.accepted_at is not null then
    raise exception '% already has access to this folder', v_target_callsign;
  end if;

  insert into folder_collaborators (folder_id, owner_id, user_id, collab_mode, joined_at, accepted_at, invite_token)
  values (p_folder_id, auth.uid(), v_target_user, v_folder.collab_mode, now(), null, p_token)
  on conflict (folder_id, user_id) do update
    set joined_at = now(), accepted_at = null, invite_token = excluded.invite_token,
        left_at = null, removed_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$$;

create or replace function public.invite_aircraft_collaborator(p_aircraft_id uuid, p_callsign text, p_role text, p_token text)
returns table(out_token text, out_user_id uuid, out_callsign text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_target_user uuid;
  v_target_callsign text;
  v_existing record;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Aircraft sharing requires Premium';
  end if;

  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select cr.user_id, cr.callsign into v_target_user, v_target_callsign
  from callsign_registry cr where cr.callsign_lower = lower(trim(p_callsign));

  if v_target_user is null then
    raise exception 'No FlyRegs user found with that Callsign';
  end if;

  if v_target_user = auth.uid() then
    raise exception 'You can''t invite yourself';
  end if;

  select * into v_existing from aircraft_collaborators
    where aircraft_id = p_aircraft_id and user_id = v_target_user and left_at is null;

  if found and v_existing.accepted_at is not null then
    raise exception '% already has access to this aircraft', v_target_callsign;
  end if;

  insert into aircraft_collaborators (aircraft_id, owner_id, user_id, role, joined_at, accepted_at, invite_token)
  values (p_aircraft_id, auth.uid(), v_target_user, p_role, now(), null, p_token)
  on conflict (aircraft_id, user_id) do update
    set role = excluded.role, joined_at = now(), accepted_at = null,
        invite_token = excluded.invite_token, left_at = null, removed_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$$;

-- ── 4. A removed person cannot un-remove themselves ─────────────────────────
-- Both tables let a collaborator UPDATE their own row (that is how
-- last_viewed_at and leaving are written), and both guards are DENY-LISTS, so
-- a column added today is permitted by default until it is named. Without
-- this, a removed collaborator could PATCH removed_at back to null and undo
-- their own removal. The owner branch is left as a deny-list on purpose:
-- removeCollaborator now writes removed_at as the owner.
create or replace function public.guard_folder_collaborator_self_update()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if auth.uid() = old.owner_id then
    -- The OWNER may change only what sharedFolders.ts actually writes as
    -- owner: collab_mode (setCollaboratorMode), and left_at + removed_at
    -- (removeCollaborator). Everything else -- above all accepted_at, which
    -- is_folder_participant trusts as the invitee's own consent signal --
    -- belongs to the invitee or to the SECURITY DEFINER invite/join RPCs,
    -- which are exempt via the current_user check above.
    if new.folder_id is distinct from old.folder_id
       or new.owner_id is distinct from old.owner_id
       or new.user_id is distinct from old.user_id
       or new.invite_token is distinct from old.invite_token
       or new.accepted_at is distinct from old.accepted_at
       or new.joined_at is distinct from old.joined_at
    then
      raise exception 'A folder owner may only change collab_mode, left_at or removed_at on a collaborator row';
    end if;
    return new;
  end if;
  if new.folder_id is distinct from old.folder_id
     or new.owner_id is distinct from old.owner_id
     or new.user_id is distinct from old.user_id
     or new.collab_mode is distinct from old.collab_mode
     or new.invite_token is distinct from old.invite_token
     or new.accepted_at is distinct from old.accepted_at
     or new.joined_at is distinct from old.joined_at
     or new.removed_at is distinct from old.removed_at
     or (new.left_at is distinct from old.left_at and not (old.left_at is null and new.left_at is not null))
  then
    raise exception 'Only last_viewed_at, or leaving (left_at null -> set), may be self-updated by a collaborator';
  end if;
  return new;
end;
$$;

create or replace function public.guard_aircraft_collaborator_self_update()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if auth.uid() = old.owner_id then
    return new;
  end if;
  if new.aircraft_id is distinct from old.aircraft_id
     or new.owner_id is distinct from old.owner_id
     or new.user_id is distinct from old.user_id
     or new.role is distinct from old.role
     or new.invite_token is distinct from old.invite_token
     or new.accepted_at is distinct from old.accepted_at
     or new.joined_at is distinct from old.joined_at
     or new.removed_at is distinct from old.removed_at
     or (new.left_at is distinct from old.left_at and not (old.left_at is null and new.left_at is not null))
  then
    raise exception 'Only last_viewed_at, or leaving (left_at null -> set), may be self-updated by a collaborator';
  end if;
  return new;
end;
$$;

commit;
