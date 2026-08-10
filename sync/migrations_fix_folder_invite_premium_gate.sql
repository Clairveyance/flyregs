-- Fix: invite_folder_collaborator had zero server-side Premium check, unlike its
-- sibling invite_aircraft_collaborator. Client-side (folder/[id].tsx) correctly
-- checked isPremium before opening the Callsign-invite modal, but the RPC itself
-- was callable directly by any authenticated user regardless of tier, letting a
-- non-Premium account create a real folder_collaborators invite row. Found via
-- the 2026-08-10 full-app tier-gate audit, live-proven with a disposable
-- non-Premium account before this fix was written.
--
-- Mirrors invite_aircraft_collaborator's exact check, added as the function's
-- first statement. Same signature -> safe CREATE OR REPLACE, no overload risk.

CREATE OR REPLACE FUNCTION public.invite_folder_collaborator(p_folder_id text, p_callsign text, p_token text)
 RETURNS TABLE(out_token text, out_user_id uuid, out_callsign text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    set joined_at = now(), accepted_at = null, invite_token = excluded.invite_token, left_at = null;

  return query select p_token, v_target_user, v_target_callsign;
end;
$function$;
