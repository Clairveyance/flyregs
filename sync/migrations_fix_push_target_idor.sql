-- Real, live-confirmed severe gap found during the B34 forensic gating
-- re-audit (2026-08-16): both push-target lookup RPCs let ANY signed-in
-- caller (and, worse, even `anon` -- both were granted to PUBLIC) pull a
-- real Expo push token for an arbitrary other user and compose the
-- notification's own text, with zero check that the caller has any real
-- relationship to the target.
--
-- get_collaboration_invite_push_target(p_target_user_id, p_resource_type,
-- p_resource_label): looked up the target's push token with no ownership
-- check at all. lookup_user_by_callsign resolves any visible Callsign
-- (leaderboards, duel lists, collaborator rosters) straight to a real
-- user_id, so the full exploit chain was: any account -> resolve a
-- victim's callsign to their user_id -> call this RPC with an arbitrary
-- p_resource_label -> get back a real push token + attacker-composable
-- title/body -> POST directly to Expo's push endpoint (src/lib/
-- notifications.ts's sendCollaborationInvitePush does exactly this, no
-- server relay). Enables spoofed, arbitrary-text notifications against
-- any real user with zero relationship required.
--
-- Fix: both real call sites (src/app/my-aircraft/[id].tsx,
-- src/app/folder/[id].tsx) already call this ONLY right after
-- inviteCollaboratorByCallsign has genuinely created a pending
-- aircraft_collaborators/folder_collaborators row -- owner_id (the
-- resource owner), user_id (the resolved target), and a random
-- invite_token are all real columns on that row already. Add p_token and
-- require a matching pending row (owner_id = caller, user_id = target,
-- invite_token = the exact token just returned from that real invite,
-- accepted_at still null) before ever touching push_tokens. An attacker
-- with no real collaborator row they own can never satisfy this -- they'd
-- need to already know a token that only the real invite-creation RPC
-- ever generates and returns to the actual resource owner.
--
-- This changes the parameter list, so CREATE OR REPLACE alone would just
-- add a second overload and leave the vulnerable 3-arg version live
-- (gotcha_create_or_replace_signature_overload.md) -- DROP the old
-- signature explicitly first.
drop function if exists public.get_collaboration_invite_push_target(uuid, text, text);

create function public.get_collaboration_invite_push_target(p_target_user_id uuid, p_resource_type text, p_resource_label text, p_token text)
 returns table(expo_push_token text, title text, body text)
 language plpgsql
 security definer
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_verified boolean := false;
begin
  if p_resource_type = 'aircraft' then
    select exists(
      select 1 from aircraft_collaborators ac
      where ac.owner_id = v_actor_id
        and ac.user_id = p_target_user_id
        and ac.invite_token = p_token
        and ac.accepted_at is null
    ) into v_verified;
  else
    select exists(
      select 1 from folder_collaborators fc
      where fc.owner_id = v_actor_id
        and fc.user_id = p_target_user_id
        and fc.invite_token = p_token
        and fc.accepted_at is null
    ) into v_verified;
  end if;

  if not v_verified then
    raise exception 'No matching pending invite found';
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_resource_type when 'aircraft' then 'Aircraft invite' else 'Folder invite' end,
    case p_resource_type
      when 'aircraft' then v_actor_label || ' invited you to ' || p_resource_label
      else v_actor_label || ' invited you to the folder "' || p_resource_label || '"'
    end
  from push_tokens pt
  where pt.user_id = p_target_user_id
    and pt.user_id != v_actor_id
    and pt.enabled = true;
end;
$function$;

-- authenticated only -- anon has no legitimate reason to ever call this
-- (nothing it does makes sense without a real auth.uid()), matching the
-- fact it was never supposed to be reachable pre-auth in the first place.
revoke all on function public.get_collaboration_invite_push_target(uuid, text, text, text) from public, anon;
grant execute on function public.get_collaboration_invite_push_target(uuid, text, text, text) to authenticated;

-- get_duel_push_target(p_challenge_id, p_event): same shape of gap, one
-- check narrower -- it correctly filters recipients to real
-- challenge_participants rows, but never confirmed the CALLER is a
-- participant of p_challenge_id before returning every other
-- participant's push token. Smaller blast radius (needs a real duel
-- UUID, not just a callsign), but still a real gap: add the same
-- membership check every other Duels RPC already uses this exact shape
-- for (create_challenge, respond_to_challenge, submit_challenge_answer).
-- Signature is unchanged, so CREATE OR REPLACE is safe here (no new
-- overload risk).
create or replace function public.get_duel_push_target(p_challenge_id uuid, p_event text)
 returns table(expo_push_token text, title text, body text)
 language plpgsql
 security definer
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
begin
  if not exists (
    select 1 from challenge_participants cp0
    where cp0.challenge_id = p_challenge_id and cp0.user_id = v_actor_id
  ) then
    raise exception 'Not a participant in this challenge';
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_event
      when 'invited' then 'Duel Invite'
      when 'accepted' then 'Duel Accepted'
      when 'completed' then 'Duel Finished'
      else 'Duel Update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' is challenging you to a duel. Accept or decline?'
      when 'accepted' then v_actor_label || ' accepted your duel — your move'
      when 'completed' then 'See how you did against ' || v_actor_label
      else 'Check your Duel with ' || v_actor_label
    end
  from challenge_participants cp
  join push_tokens pt on pt.user_id = cp.user_id
  where cp.challenge_id = p_challenge_id
    and cp.user_id != v_actor_id
    and pt.enabled = true
    and pt.duel_notifications_enabled = true
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
    );
end;
$function$;

revoke all on function public.get_duel_push_target(uuid, text) from public, anon;
grant execute on function public.get_duel_push_target(uuid, text) to authenticated;
