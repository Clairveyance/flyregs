-- invite_aircraft_collaborator (the Callsign-targeted invite RPC, built in
-- a17bb09 to replace the earlier anonymous share_code flow) never got the
-- same server-side Premium check that flow's replacement, join_shared_
-- aircraft, already has on the JOINER side, or that synced_folders' own
-- trg_enforce_folder_share_premium trigger has on the folder-owner side.
-- The client-side gate (my-aircraft/[id].tsx's handleShare) is real, but
-- it's the ONLY thing stopping a non-Premium owner -- a raw REST call to
-- this RPC with a valid Free-tier JWT succeeds today. Confirmed live: a
-- throwaway account with zero user_entitlements row created a real
-- pending invite via direct RPC call (200 OK), no client involved.
--
-- Net effect before this fix: a non-Premium owner can't actually complete
-- a share (join_shared_aircraft still correctly blocks a non-Premium
-- INVITEE from accepting), but they can freely use the rest of the
-- Premium "invite a collaborator" feature -- minting real invites, seeing
-- them land in their own roster as "Invited" -- for free. Same fail-
-- closed pattern as every other gate here: missing user_entitlements row
-- means false, never accidental access.
create or replace function public.invite_aircraft_collaborator(p_aircraft_id uuid, p_callsign text, p_role text, p_token text)
 returns table(out_token text, out_user_id uuid, out_callsign text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
    set role = excluded.role, joined_at = now(), accepted_at = null, invite_token = excluded.invite_token, left_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$function$;
