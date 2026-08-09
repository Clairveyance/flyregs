-- ============================================================================
-- Folder sharing: invite a specific person by Callsign, pending until they
-- accept -- mirrors migrations_aircraft_pending_invites.sql, ported for
-- folders -- 2026-08-09
--
-- RC: "since the receiver has to have a FR account to get the shared
-- folders... it's not bad to suggest there too (like with a/c sharing) that
-- they create a Callsign... scope it a build it. should be fairly
-- straightforward since you already built it in the a/c area." Reuses
-- lookup_user_by_callsign(text) as-is -- it was already generic, not
-- aircraft-scoped, when the aircraft migration created it.
--
-- Previously folder_collaborators rows were only ever created at redemption
-- time (join_shared_folder), off one anonymous share_token per folder shared
-- by anyone who has the link. This adds a per-invite row + token so a
-- SPECIFIC Callsign can be targeted, shown pending, and revoked before they
-- ever accept -- the anonymous share_token path (folder/[id].tsx's existing
-- "Invite" header icon) is left fully intact for anyone who prefers it.
-- ============================================================================

alter table folder_collaborators add column if not exists accepted_at timestamptz;
alter table folder_collaborators add column if not exists invite_token text;
create unique index if not exists idx_folder_collaborators_invite_token
  on folder_collaborators(invite_token) where invite_token is not null;

-- Every row that existed before this migration was created at redemption
-- time (the old join_shared_folder always inserted with the person already
-- joined) -- so it's already a real, accepted collaborator.
update folder_collaborators set accepted_at = joined_at where accepted_at is null;

-- p_token is generated client-side (same makeShareToken() pattern already
-- used for the anonymous share_token), matching every other invite link in
-- this app. New invite inherits the folder's CURRENT default collab_mode
-- (same starting point an anonymous-link joiner gets) -- the owner can
-- customize this one person's mode afterward via the existing
-- setCollaboratorMode (BB-077), unchanged by this migration.
create or replace function invite_folder_collaborator(p_folder_id text, p_callsign text, p_token text)
returns table(out_token text, out_user_id uuid, out_callsign text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_folder record;
  v_target_user uuid;
  v_target_callsign text;
  v_existing record;
begin
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
    set joined_at = now(), accepted_at = null, invite_token = excluded.invite_token, left_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$$;
grant execute on function invite_folder_collaborator(text, text, text) to authenticated;

-- join_shared_folder: try the targeted invite_token path first (belongs to
-- ONE specific invited user -- redeeming it as anyone else would defeat the
-- entire point of naming a recipient by Callsign), falling back to the
-- existing anonymous share_token path for the "Invite" header icon's link.
create or replace function join_shared_folder(p_token text)
returns table(out_folder_id text, out_folder_name text)
language plpgsql
security definer
set search_path to 'public'
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
  insert into folder_collaborators (folder_id, owner_id, user_id, collab_mode, accepted_at)
  values (v_folder.id, v_folder.user_id, auth.uid(), v_folder.collab_mode, now())
  on conflict (folder_id, user_id) do update set left_at = null, accepted_at = now();
  return query select v_folder.id, v_folder.name;
end;
$$;

-- get_folder_collaborators: adds out_accepted so the owner-side roster can
-- grey out a not-yet-accepted invite instead of showing it exactly like a
-- real collaborator -- same treatment my-aircraft/[id].tsx's roster already
-- has. Return-column set changed, so this needs a real DROP, not just
-- CREATE OR REPLACE (see gotcha_create_or_replace_signature_overload).
drop function if exists get_folder_collaborators(text);
create function get_folder_collaborators(p_folder_id text)
returns table(out_user_id uuid, out_display_label text, out_joined_at timestamptz, out_left_at timestamptz, out_last_viewed_at timestamptz, out_collab_mode text, out_accepted boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from synced_folders where id = p_folder_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
    select
      fc.user_id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at,
      fc.collab_mode,
      (fc.accepted_at is not null)
    from folder_collaborators fc
    join auth.users u on u.id = fc.user_id
    left join callsign_registry cr on cr.user_id = fc.user_id
    where fc.folder_id = p_folder_id;
end;
$$;
grant execute on function get_folder_collaborators(text) to authenticated;
