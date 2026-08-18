-- Root cause of RC's forwarded "Invite by Callsign is a no-op" report
-- (sender gets no confirmation problem never reproduced -- create_challenge
-- always throws a real, actionable error or succeeds and navigates to the
-- new duel screen -- but "no push received by the invitee" DID reproduce,
-- live, 2026-08-17):
--
-- src/lib/notifications.ts's enableDuelNotifications() upserts a brand-new
-- push_tokens row with `enabled: existing?.enabled ?? false` -- i.e. a user
-- who turns ON "Duel Alerts" in Account WITHOUT ever having touched "AC
-- Update Alerts" first (a perfectly normal thing to do -- they're two
-- separate, separately-labeled toggles) gets a token row with
-- duel_notifications_enabled=true but enabled=false. isDuelNotificationsEnabled()
-- only reads duel_notifications_enabled, so their Account toggle correctly
-- shows ON -- but get_duel_push_target's WHERE clause required BOTH
-- pt.enabled = true AND pt.duel_notifications_enabled = true, so this user
-- silently NEVER qualifies as a push target for ANY duel event (invited/
-- accepted/completed), for ANY invite mechanism (Callsign, Find Friends,
-- recent opponents alike) -- not specific to Callsign at all, just most
-- likely to surface there since that's the path for inviting someone who
-- isn't already a frequent opponent.
--
-- This directly contradicts this exact function's own header comment:
-- "own opt-in column on push_tokens, off by default, INDEPENDENT of the
-- base AC Update Alerts `enabled` flag." The write-side default is really a
-- second, harder-to-fix half of the same bug (flipping it to default
-- enabled=true on a brand-new row would make isAcUpdateAlertsEnabled() --
-- which only reads `enabled` -- silently report AC Update Alerts as ON for
-- someone who only ever asked for Duel Alerts, the exact cross-contamination
-- that write-side logic was trying to avoid in the first place). The actual
-- fix belongs on this RPC's read side: stop requiring the AC-Update-Alerts-
-- specific `enabled` flag for a completely different, independently-gated
-- notification type. reg_of_day/word_of_day's send scripts have this same
-- enabled-AND-feature-flag shape (send-reg-of-day.mjs, send-word-of-day.mjs)
-- -- deliberately NOT touched here, out of scope for a Duels-only fix.
--
-- Live-verified before/after with two disposable @flyregs.invalid accounts
-- and a fake (never-real-device) Expo token: with a fresh
-- duel_notifications_enabled=true/enabled=false row (exactly what
-- enableDuelNotifications() writes today for a first-time Duel-only
-- opt-in), get_duel_push_target('invited') returned zero rows before this
-- fix and the correct single target row after. Same signature -> safe
-- CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    and pt.duel_notifications_enabled = true
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
    );
end;
$function$;
