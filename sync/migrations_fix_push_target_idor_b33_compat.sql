-- Bug #3/#4 (2026-08-16 beta reports, both RC and Adriana independently):
-- "Invite by Callsign completely broken... doesn't send a push
-- notification, doesn't send the folder to the recipient at all."
--
-- Root cause confirmed live, not guessed: the currently-shipped TestFlight
-- build (B33, git commit 3546a936, cut 2026-08-16T03:01 UTC) was built
-- BEFORE tonight's migrations_fix_push_target_idor.sql. B33's own
-- src/lib/notifications.ts (confirmed via `git show 3546a936:...`) calls
--   supabase.rpc('get_collaboration_invite_push_target', {
--     p_target_user_id, p_resource_type, p_resource_label   -- 3 args, no token
--   })
-- migrations_fix_push_target_idor.sql (correctly, for real security
-- reasons -- see its own comment) DROPPED that exact 3-arg signature and
-- replaced it with a 4-arg one requiring p_token. A DROP takes effect on
-- the server immediately; B33's binary can't be updated without a new EAS
-- build + TestFlight review. Every callsign invite sent from a real B33
-- device since that migration landed has been silently failing --
-- PostgREST can't resolve the call to any function, sendCollaborationInvite
-- Push's `if (error) return` swallows it with zero signal anywhere. This
-- matches the bug reports exactly: nothing happens, no push, no error.
--
-- src/lib/notifications.ts in this working tree already calls the RPC with
-- the real 4-arg signature (p_token included) -- that's the actual fix,
-- but it only takes effect once a new build (B34) ships and passes Beta
-- App Review. Until then, restore a SECURE 3-arg overload (not the
-- original vulnerable one -- that one had ZERO ownership check at all) so
-- B33 keeps working in the field. This still requires the caller to be a
-- genuine resource owner with a real PENDING (accepted_at is null) invite
-- row targeting that exact victim -- an attacker can't manufacture that
-- without first creating a real invite through the legitimate, Premium-
-- gated invite_folder_collaborator/invite_aircraft_collaborator RPCs,
-- which already enforce ownership + entitlement. The only thing this
-- overload can't do that the 4-arg one can is pin the exact invite_token,
-- so a caller who has already legitimately invited someone could in
-- principle call this again to re-send that SAME real invite's push --
-- not the "arbitrary victim, zero relationship" exploit the original bug
-- was about. Materially closes the same IDOR for the population that can
-- actually reach this overload.
--
-- DROP THIS OVERLOAD once B34 has fully rolled out and no client still on
-- B33 (or earlier) remains in the field -- tracked in
-- PROJECT_NOTES/flyregs_pending.md.
drop function if exists public.get_collaboration_invite_push_target(uuid, text, text);

create function public.get_collaboration_invite_push_target(p_target_user_id uuid, p_resource_type text, p_resource_label text)
 returns table(expo_push_token text, title text, body text)
 language plpgsql
 security definer
 set search_path to 'public'
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
        and ac.accepted_at is null
    ) into v_verified;
  else
    select exists(
      select 1 from folder_collaborators fc
      where fc.owner_id = v_actor_id
        and fc.user_id = p_target_user_id
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

revoke all on function public.get_collaboration_invite_push_target(uuid, text, text) from public, anon;
grant execute on function public.get_collaboration_invite_push_target(uuid, text, text) to authenticated;

-- Re-affirm the 4-arg (real, token-verified) version stays exactly as
-- migrations_fix_push_target_idor.sql left it -- this file only adds the
-- 3-arg compat overload back, it doesn't touch the 4-arg one.
