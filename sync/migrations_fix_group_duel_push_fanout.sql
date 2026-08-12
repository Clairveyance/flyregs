-- RC: "clean up all... features." Closes a gap documented in the code's
-- own comment as a known 1:1-era holdover, never built: sendDuelPush only
-- ever notifies ONE other participant, even in a 3+ person group duel.
--
-- get_duel_push_target already correctly SELECTS every qualifying
-- participant per event type (excludes the actor, filters by the right
-- status per event) -- the bug was purely the trailing `limit 1`. That
-- cap was silently harmless for 'accepted' (is_creator=true naturally
-- matches exactly one row per challenge) but wrong for 'invited' (should
-- notify every still-pending invitee) and 'completed' (should notify
-- every other still-active participant), both of which can be 2+ people
-- in a group duel.
CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
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
    case p_event
      when 'invited' then 'Duel invite'
      when 'accepted' then 'Duel accepted'
      when 'completed' then 'Duel finished'
      else 'Duel update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' challenged you to a duel'
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
GRANT EXECUTE ON FUNCTION public.get_duel_push_target(uuid, text) TO authenticated, service_role, postgres;
