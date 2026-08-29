-- RC (2026-08-29, in-app feedback, live joint testing with Adriana): a real
-- callsign invite (folder AND aircraft, both go through this same RPC)
-- shows "invite sent" on the sender's side but the recipient never gets a
-- notification. Root cause: get_collaboration_invite_push_target's final
-- filter requires `pt.enabled = true` -- but `enabled` is NOT a generic
-- "this device has a working push token" flag, it is specifically the
-- Premium-gated "AC Update Alerts" feature toggle (the ONLY code path that
-- ever sets it true is enableAcUpdateAlerts() in src/lib/notifications.ts).
-- Duels' own enableDuelNotifications() already had to work around this same
-- confusion by adding its OWN separate duel_notifications_enabled column
-- rather than reusing `enabled` -- collaboration invites never got the same
-- treatment and are still keyed off the wrong flag.
--
-- Net effect: a folder/aircraft collaboration invite can only ever reach
-- someone who has separately, specifically enabled the unrelated Premium
-- AC-alerts feature. Any non-Premium user, or any Premium user who simply
-- hasn't touched that one toggle, has a real push_tokens row (once they've
-- enabled ANY push feature) that this query silently filters out. Adriana
-- (a brand-new account created minutes before this test) is the extreme
-- case -- zero push_tokens row of any kind -- but the bug is broader than
-- her specific case: anyone who enabled Duel notifications or DailyReg/
-- DailyWord WITHOUT also touching AC Update Alerts is silently unreachable
-- for a collaboration invite too, since none of those set `enabled=true`.
--
-- Fix: this RPC already verifies a real, owner-created, token-matched
-- pending invite exists before it ever runs (see migrations_fix_push_target_
-- idor.sql) -- that's the actual security boundary, not the AC-alerts flag.
-- Drop the `enabled` requirement entirely here; a non-null expo_push_token
-- means the device has SOME live registered token, which is all a targeted,
-- already-relationship-verified invite notification needs. Signature is
-- unchanged (still 4 args), so CREATE OR REPLACE is safe -- no new overload.
--
-- Deliberately NOT touching get_duel_push_target's identical `pt.enabled =
-- true` requirement in this same migration file's earlier version -- that's
-- a real, analogous latent gap (flagged to RC separately) but nothing
-- reported it broken tonight, and touching an unreported path risks a
-- regression in an area not actually being tested right now.
create or replace function public.get_collaboration_invite_push_target(p_target_user_id uuid, p_resource_type text, p_resource_label text, p_token text)
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
    and pt.expo_push_token is not null;
end;
$function$;

revoke all on function public.get_collaboration_invite_push_target(uuid, text, text, text) from public, anon;
grant execute on function public.get_collaboration_invite_push_target(uuid, text, text, text) to authenticated;
