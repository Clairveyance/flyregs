-- Invite by Callsign (aircraft + folder) previously resolved the callsign
-- server-side into a real pending collaborator row, then fell back to the
-- OS share sheet anyway -- as if it were an anonymous link invite. RC (real
-- device, 2026-08-15): "it just opens the iOS typical 'send to...' screen...
-- it shouldn't do that at all, with a callsign, that an inside-FR feature
-- and should simply locate the user with that callsign and send them the
-- invite." This mirrors get_duel_push_target's exact shape (SECURITY
-- DEFINER, actor-label lookup, returns expo_push_token/title/body) so the
-- client can push-notify the resolved user directly instead of opening a
-- share sheet. Gated on push_tokens.enabled (the base opt-in) rather than a
-- new per-feature column -- there's no existing "collaboration invites"
-- toggle to check, and adding one would be new scope beyond this fix.
CREATE OR REPLACE FUNCTION public.get_collaboration_invite_push_target(
  p_target_user_id uuid,
  p_resource_type text,
  p_resource_label text
)
RETURNS TABLE(expo_push_token text, title text, body text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
begin
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

GRANT EXECUTE ON FUNCTION public.get_collaboration_invite_push_target(uuid, text, text) TO authenticated;
