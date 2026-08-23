-- Duel push notifications: add the missing 4th event -- "your opponent
-- finished their answers, your move" -- RC-approved 2026-08-23: fire once
-- per participant when THEY finish their own full set of questions (not
-- once per question, which would mean up to 5 pushes/opponent/duel), sent
-- to whichever other active participants haven't finished their own set
-- yet. If a participant's own finish also happens to be the very LAST one
-- needed (challenge_completed), the existing 'completed' push already
-- covers that -- this new event only fires when someone finishes early,
-- with the duel still genuinely open for others.
--
-- Real gap this closes: previously nothing told the other person in a
-- 2-player duel that their opponent had answered and was waiting -- they
-- only found out by happening to open the app and check.

-- ---------------------------------------------------------------------------
-- submit_challenge_answer: new output column my_set_completed -- true when
-- THIS submission was the current user's own last unanswered question
-- (independent of whether the whole duel just finalized). Computed the
-- same way finalize_challenge_if_done() already checks per-participant
-- completion, so the two can never disagree.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_challenge_answer(uuid, text, integer);

CREATE FUNCTION public.submit_challenge_answer(p_question_id uuid, p_answer_text text, p_time_ms integer)
 RETURNS TABLE(is_correct boolean, correct_answer text, others_answered_count integer, others_total_count integer, challenge_completed boolean, my_set_completed boolean, new_coins text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_active_count int;
  v_total_questions int;
begin
  select cq.challenge_id,
    coalesce(
      cq.correct_answer,  -- real authored answer, denormalized at creation time
      case cq.item_type
        when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
        else cq.item_id
      end
    )
  into v_challenge_id, v_term
  from challenge_questions cq
  join challenges c on c.id = cq.challenge_id
  where cq.id = p_question_id
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and c.status = 'active';

  if not found then
    raise exception 'Question not found or challenge not active for you';
  end if;

  v_is_correct := (p_answer_text = v_term);

  insert into challenge_answers (challenge_question_id, user_id, answer_text, is_correct, time_ms)
  values (p_question_id, auth.uid(), p_answer_text, v_is_correct, p_time_ms)
  on conflict (challenge_question_id, user_id) do nothing;

  is_correct := v_is_correct;
  correct_answer := v_term;

  select count(*) into v_active_count from challenge_participants
    where challenge_id = v_challenge_id and status = 'active';
  select count(*) into others_answered_count
  from challenge_answers ca
  where ca.challenge_question_id = p_question_id and ca.user_id != auth.uid();
  others_total_count := v_active_count - 1;

  select count(*) into v_total_questions from challenge_questions where challenge_id = v_challenge_id;
  select (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
          where cq.challenge_id = v_challenge_id and ca.user_id = auth.uid()) = v_total_questions
    into my_set_completed;

  new_coins := finalize_challenge_if_done(v_challenge_id);
  select c.status = 'completed' into challenge_completed from challenges c where c.id = v_challenge_id;
  challenge_completed := coalesce(challenge_completed, false);

  return next;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.submit_challenge_answer(uuid, text, integer) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- get_duel_push_target: add the 'answered' case. Recipients = other active
-- participants who have NOT YET finished their own full set (the ones this
-- notification is actually for -- "your move"). Someone who's already
-- finished and is just waiting on others gets nothing new here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
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

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
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
