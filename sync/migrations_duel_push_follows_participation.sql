-- A duel participant who may still PLAY must still be NOTIFIED.
--
-- migrations_duel_push_pref_not_destroyed.sql (earlier today) correctly dropped
-- the trigger that was rewriting users' stored Duel Alerts preference, and moved
-- tier enforcement to send time in get_duel_push_target:
--
--     and public.has_pro_access(cp.user_id)
--
-- That line is wrong, for two independent reasons found while verifying the fix
-- on real accounts.
--
-- 1. IT CONTRADICTS THE DESIGN THIS REPO ALREADY SETTLED.
--    Per scripts/duel_downgrade_midmatch_test.py and the three migrations it
--    cites, mid-duel entitlement handling was deliberately landed as:
--      * create_challenge / respond_to_challenge(accept): Premium REQUIRED --
--        starting or accepting a NEW duel is the gate.
--      * get_next_challenge_question / submit_challenge_answer: NO tier gate --
--        "gameplay stays open even if a participant's Premium lapses mid-duel,
--        so a downgraded participant can still finish and doesn't soft-lock
--        their opponent's duel forever." That softlock was a real regression
--        once already (migrations_fix_duel_nonpremium_invite_softlock.sql).
--      * finalize_challenge_if_done: re-checks LIVE is_premium, because that is
--        where a REWARD is written -- a lapsed player's answers still count for
--        fairness, but they earn no win/loss/coin.
--    A tier check on the push path puts the softlock straight back, one layer
--    over: the lapsed player may still answer, but never hears that it is their
--    move, so the duel stalls for BOTH players. Participation is the
--    authorization here; the gate already ran at create/accept.
--
-- 2. IT RE-INTRODUCES THE EXACT STALENESS THAT CAUSED THE ORIGINAL BUG.
--    has_pro_access() reads user_entitlements -- the row sync-entitlements
--    rewrites on sign-in and foreground. That row being briefly absent or stale
--    is what let the old trigger destroy RC's setting. Reading it again at send
--    time no longer destroys anything, but it silently DROPS a real
--    notification for a fully-paid participant during the same window. Trading
--    a corrupted preference for a missed push is not a fix; missed pushes are
--    the complaint.
--    The asymmetry decides it: notifying someone whose subscription lapsed
--    mid-duel costs nothing -- they are in a duel they may legitimately finish
--    -- while dropping a notification is the failure being fixed.
--
-- Also note has_pro_access is `is_pro OR is_premium` while Duels are
-- Premium-only, so the predicate never matched the gate it was imitating
-- anyway. (Same class of mistake as find_users_for_invite.duel_ready, fixed in
-- migrations_duel_ready_matches_real_gate.sql.)
--
-- The user's own duel_notifications_enabled preference still governs, as it
-- always should.

begin;

create or replace function public.get_duel_push_target(p_challenge_id uuid, p_event text)
returns table(expo_push_token text, title text, body text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
    -- The user's own choice, and NOTHING else. Tier was enforced at
    -- create_challenge / respond_to_challenge; being a participant row IS the
    -- authorization, and gameplay deliberately stays open after a lapse, so
    -- notifications must too. No entitlement lookup belongs on this path --
    -- see this file's header.
    and pt.duel_notifications_enabled = true
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
$function$;

commit;
