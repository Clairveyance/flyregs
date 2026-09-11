-- A tier check must never silently rewrite a user's stored preference.
--
-- RC, 2026-09-11, on his own production account: "my duel alerts was off. i
-- never turned it off. i always had it on. which means something in our
-- system did it."  He was right, and this is what did it.
--
-- trg_enforce_duel_push_pro_gate fired BEFORE INSERT **OR UPDATE** on
-- push_tokens and, whenever has_pro_access() read false, forced
--     NEW.duel_notifications_enabled := false
-- silently, with no record that a preference had been changed.
--
-- registerPushToken() upserts push_tokens on EVERY app foreground
-- (ensurePushTokenRegisteredIfGranted). has_pro_access() reads
-- user_entitlements, and that row is written by syncEntitlements() AFTER
-- sign-in. So any foreground that happened while the entitlement row was
-- momentarily absent or stale -- a fresh install, the first seconds after a
-- sign-in, a RevenueCat hiccup, a reinstall, an upgrade mid-flight -- turned
-- Duel Alerts off permanently. Permanently, because the register path
-- preserves `prior` on later runs, so once false it stays false; the
-- 2026-09-04 "default every toggle ON" change only ever applied to users
-- with NO prior row, so it never repaired anyone already flipped off.
--
-- Corroboration on RC's own row: `enabled`, `reg_of_day_enabled` and
-- `word_of_day_enabled` were all still true. The ONLY column that was false
-- is the only column this trigger touches.
--
-- Fix, in two halves:
--   1. Drop the trigger. A stored preference is the user's, and nothing but
--      the user may change it.
--   2. Enforce the tier where it actually matters -- at SEND time, inside
--      get_duel_push_target -- so an unentitled user simply isn't sent a duel
--      push, and gets their own setting back untouched the moment they are
--      entitled again. ("Guard on the side that cannot be stale.")
--
-- This is deliberately NOT a loosening: before this change a non-Pro user
-- with the flag somehow true would have been sent a push, because
-- get_duel_push_target never checked tier at all -- it trusted the trigger to
-- have scrubbed the column. Now the check is explicit and in the send path.

begin;

drop trigger if exists trg_enforce_duel_push_pro_gate on public.push_tokens;
drop function if exists public.enforce_duel_push_pro_gate();

CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_total_questions int;
begin
  if not exists (
    select 1 from challenge_participants cp0
    where cp0.challenge_id = p_challenge_id and cp0.user_id = v_actor_id
  ) then
    raise exception 'Not a participant in this challenge';
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  select count(*) into v_total_questions from challenge_questions where challenge_id = p_challenge_id;

  return query
  select pt.expo_push_token,
    case p_event
      when 'invited' then 'Duel Invite'
      when 'accepted' then 'Duel Accepted'
      when 'answered' then 'Your Move'
      when 'completed' then 'Duel Finished'
      else 'Duel Update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' is challenging you to a duel. Accept or decline?'
      when 'accepted' then v_actor_label || ' accepted your duel — your move'
      when 'answered' then v_actor_label || ' finished their answers — your move'
      when 'completed' then 'See how you did against ' || v_actor_label
      else 'Check your Duel with ' || v_actor_label
    end
  from challenge_participants cp
  join push_tokens pt on pt.user_id = cp.user_id
  where cp.challenge_id = p_challenge_id
    and cp.user_id != v_actor_id
    and pt.duel_notifications_enabled = true
    -- Tier is enforced HERE, at send time, not by mutating the user's
    -- stored preference. See migrations_duel_push_pref_not_destroyed.sql.
    and public.has_pro_access(cp.user_id)
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
      or (
        p_event = 'answered' and cp.status = 'active'
        and (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
             where cq.challenge_id = p_challenge_id and ca.user_id = cp.user_id) < v_total_questions
      )
    );
end;
$function$


commit;
