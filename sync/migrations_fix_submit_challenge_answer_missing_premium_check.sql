-- RC, 2026-08-14: "make sure these two worktree items are dealt with: Add
-- live-entitlement re-check to submit_challenge_answer" -- flagged during
-- the same-day gating re-sweep as a genuine partial DOWN-direction gap:
-- unlike create_challenge() and respond_to_challenge() (both of which
-- correctly require `is_premium` before letting a user start/accept a
-- Duel), submit_challenge_answer() -- called on every question answer
-- during an ACTIVE duel -- never re-checked it at all. A participant whose
-- Premium lapses mid-duel could keep answering questions (the paid
-- interactive feature itself) for the rest of the game; finalize_challenge_
-- if_done() already correctly denies them credit/coins at the end (no
-- reward was ever extractable), but the gameplay itself stayed open the
-- whole time it shouldn't have been.
--
-- Fix: same check create_challenge() already uses verbatim (direct
-- user_entitlements query, not the has_pro_access()/has_plus_access()
-- helpers -- matching the sibling Duels functions' own existing style, not
-- introducing a new one), added right after the existing active-
-- participant/active-challenge check so it fires before any answer is
-- recorded.
CREATE OR REPLACE FUNCTION public.submit_challenge_answer(p_question_id uuid, p_answer_text text, p_time_ms integer)
 RETURNS TABLE(is_correct boolean, correct_answer text, others_answered_count integer, others_total_count integer, challenge_completed boolean, new_coins text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_active_count int;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

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

  new_coins := finalize_challenge_if_done(v_challenge_id);
  select c.status = 'completed' into challenge_completed from challenges c where c.id = v_challenge_id;
  challenge_completed := coalesce(challenge_completed, false);

  return next;
end;
$function$;
