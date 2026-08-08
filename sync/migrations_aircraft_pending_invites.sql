-- ============================================================================
-- Aircraft sharing: invite a specific person by Callsign, pending until
-- they accept  --  2026-08-07
--
-- RC: "when someone sends invites, they should see those in the same
-- place in their MF page where they would normally view/edit all that.
-- you show as 'invited' and greyed out a bit, until you accept and then
-- your name brightens up to normal. Sender should also be able to revoke
-- the invite at anytime (same as removing that shared access." And on
-- capturing who's being invited: "the 'name' [is] the person's Callsign
-- from the app."
--
-- Previously aircraft_collaborators rows were only ever created at
-- redemption time (join_shared_aircraft), off one anonymous share_code
-- per aircraft shared by anyone who has the link. This adds a per-invite
-- row + token so a SPECIFIC Callsign can be targeted, shown pending, and
-- revoked before they ever accept -- the anonymous share_code path is
-- left intact for any link already sent before this change.
-- ============================================================================

alter table aircraft_collaborators add column if not exists accepted_at timestamptz;
alter table aircraft_collaborators add column if not exists invite_token text;
create unique index if not exists idx_aircraft_collaborators_invite_token
  on aircraft_collaborators(invite_token) where invite_token is not null;

-- Every row that existed before this migration was created at redemption
-- time (the old join_shared_aircraft always inserted with the person
-- already joined) -- so it's already a real, accepted collaborator.
update aircraft_collaborators set accepted_at = joined_at where accepted_at is null;

-- Case-insensitive Callsign lookup, same handle shown everywhere else in
-- the app (Duels, collaborator lists) -- lets the invite UI resolve a
-- typed Callsign to a real account before generating a link.
create or replace function lookup_user_by_callsign(p_callsign text)
returns table(out_user_id uuid, out_callsign text)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return query
    select cr.user_id, cr.callsign
    from callsign_registry cr
    where cr.callsign_lower = lower(trim(p_callsign));
end;
$$;
grant execute on function lookup_user_by_callsign(text) to authenticated;

-- p_token is generated client-side (same makeShareToken() pattern already
-- used for the anonymous share_code) and passed in, matching how every
-- other share/invite link in this app is minted.
create or replace function invite_aircraft_collaborator(p_aircraft_id uuid, p_callsign text, p_role text, p_token text)
returns table(out_token text, out_user_id uuid, out_callsign text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_target_user uuid;
  v_target_callsign text;
  v_existing record;
begin
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
    set role = excluded.role, joined_at = now(), accepted_at = null, invite_token = excluded.invite_token, left_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$$;
grant execute on function invite_aircraft_collaborator(uuid, text, text, text) to authenticated;

-- Owner can pull back a not-yet-accepted invite the same way they'd
-- remove an already-accepted collaborator -- same underlying row, so
-- this is really just removeCollaborator's existing RPC, unchanged. No
-- new revoke function needed; see remove_aircraft_collaborator below
-- (kept for reference, not altered).

-- join_shared_aircraft: try the targeted invite_token path first (the
-- token belongs to ONE specific invited user -- redeeming it as anyone
-- else would defeat the entire point of naming a recipient by Callsign),
-- falling back to the legacy anonymous share_code path for any link
-- already sent before this change.
create or replace function join_shared_aircraft(p_code text)
returns table(out_aircraft_id uuid, out_nickname text, out_make text, out_model text, out_role text)
language plpgsql
security definer
set search_path to 'public'
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

  insert into aircraft_collaborators (aircraft_id, owner_id, user_id, role, joined_at, accepted_at)
  values (v_aircraft.id, v_aircraft.user_id, auth.uid(), v_aircraft.share_code_role, now(), now())
  on conflict (aircraft_id, user_id) do update
    set role = excluded.role, left_at = null, joined_at = now(), accepted_at = now();

  return query select v_aircraft.id, v_aircraft.nickname, v_aircraft.make, v_aircraft.model, v_aircraft.share_code_role;
end;
$$;

-- get_aircraft_collaborators: adds out_accepted so the owner-side roster
-- can grey out a not-yet-accepted invite instead of showing it exactly
-- like a real collaborator. Return-column set changed, so this needs a
-- real DROP, not just CREATE OR REPLACE (see gotcha_create_or_replace_signature_overload).
drop function if exists get_aircraft_collaborators(uuid);
create function get_aircraft_collaborators(p_aircraft_id uuid)
returns table(out_user_id uuid, out_display_label text, out_role text, out_joined_at timestamptz, out_last_viewed_at timestamptz, out_accepted boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
    select ac.user_id, coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      ac.role, ac.joined_at, ac.last_viewed_at, (ac.accepted_at is not null)
    from aircraft_collaborators ac
    join auth.users u on u.id = ac.user_id
    left join callsign_registry cr on cr.user_id = ac.user_id
    where ac.aircraft_id = p_aircraft_id and ac.left_at is null;
end;
$$;
grant execute on function get_aircraft_collaborators(uuid) to authenticated;

-- Anon-callable aircraft-invite preview for the website's join/index.php
-- rich-link card (mirrors get_shared_folder_preview exactly). Only
-- resolves a PENDING invite token -- once accepted, the link has done
-- its job and a stale preview isn't needed.
create or replace function get_shared_aircraft_preview(p_token text)
returns table(out_nickname text, out_make text, out_model text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aircraft_id uuid;
begin
  select aircraft_id into v_aircraft_id from aircraft_collaborators
    where invite_token = p_token and accepted_at is null and left_at is null;

  if v_aircraft_id is null then
    return;
  end if;

  return query select ua.nickname, ua.make, ua.model from user_aircraft ua where ua.id = v_aircraft_id;
end;
$$;
grant execute on function get_shared_aircraft_preview(text) to anon;
grant execute on function get_shared_aircraft_preview(text) to authenticated;
