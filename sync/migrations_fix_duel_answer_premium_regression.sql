-- Fixes a real regression, live-reproduced during the B34 "all-app function
-- test" (2026-08-16): migrations_fix_submit_challenge_answer_missing_
-- premium_check.sql (2026-08-14) added a hard `raise exception 'Duels
-- requires Premium'` to submit_challenge_answer() -- but this directly
-- reintroduces the exact failure mode that migrations_fix_duel_finalize_
-- entitlement_check.sql (2026-08-10) had already deliberately avoided, and
-- says so explicitly in its own header comment: "blocking mid-answer would
-- leave the OTHER participant's duel stuck forever (finalize_challenge_
-- if_done only completes once every active participant has answered every
-- question)".
--
-- Live-reproduced exactly that: user A (Premium) finishes answering every
-- question. User B (also Premium at accept-time) downgrades to Pro
-- mid-duel. B can still see their next question (get_next_challenge_
-- question has no gate) but submit_challenge_answer now hard-rejects with
-- "Duels requires Premium" -- so B can never finish, challenge_participants
-- stays 'active' forever, and A's duel can never finalize. A's opponent did
-- nothing wrong and has no way to escape this.
--
-- The Aug 14 migration's underlying worry was legitimate (a lapsed
-- participant shouldn't get to keep enjoying the paid feature indefinitely
-- with zero consequence) -- but the Aug 10 fix ALREADY solves that at the
-- correct point: finalize_challenge_if_done() re-checks each participant's
-- LIVE is_premium immediately before writing any permanent win/loss/tie/
-- coin record, so a lapsed participant's answers still count for their
-- opponents' correct-count comparisons (fair to the people who didn't
-- lapse), but they personally receive no reward. That enforcement is
-- unchanged by this migration and remains the actual revenue-integrity
-- backstop. This migration only removes the newer, over-broad gameplay
-- block that stops someone from finishing a duel they legitimately started
-- as Premium.
--
-- Net effect: gameplay stays open for an in-progress duel regardless of a
-- mid-duel entitlement change (matching get_next_challenge_question, which
-- already has no such gate), while create_challenge/respond_to_challenge
-- (starting or accepting a NEW duel) and finalize_challenge_if_done
-- (crediting the result) remain Premium-gated exactly as before -- both of
-- those are untouched by this migration.
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
