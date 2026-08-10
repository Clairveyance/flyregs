-- ============================================================================
-- FIX: Duels "peek before you answer" via challenge_answers RLS    2026-08-10
-- ============================================================================
--
-- Found during the same RLS-policy audit as
-- migrations_fix_collaborator_self_escalation.sql.
--
-- BUG: challenge_answers_participants_read (SELECT) only checked that the
-- reader is A PARTICIPANT of the challenge that owns the question -- not
-- that the reader had answered that SAME question yet. The app's own UI
-- never queries challenge_answers directly (only via SECURITY DEFINER RPCs:
-- get_next_challenge_question, submit_challenge_answer,
-- get_challenge_results/standings), so normal use of the app never tripped
-- this -- but RLS, not the app's UI, is the actual boundary PostgREST
-- enforces, and the raw table was reachable by anyone with a valid session.
--
-- Live-tested and confirmed exploitable 2026-08-10 with two disposable
-- @flyregs.invalid accounts (created and fully deleted in the same
-- session): A submitted an answer via the real submit_challenge_answer RPC;
-- B, who had NOT yet answered, did a raw PostgREST GET on
-- /rest/v1/challenge_answers and successfully read A's answer_text and
-- is_correct before ever submitting an answer of their own -- i.e. any
-- technically-inclined duel participant could see the correct answer before
-- committing to their own.
--
-- FIX: a participant may still always read their OWN answer row. Reading
-- anyone else's answer for a question now additionally requires that the
-- reader has already submitted their own answer to that SAME question
-- (simultaneous-reveal semantics). Answers can never be updated after
-- insert (no UPDATE grant/policy exists on this table -- see
-- migrations_grants_lockdown.sql), so "have I already answered this
-- question" is a safe, un-gameable gate: once true it can't be undone to
-- re-peek before changing an answer.
--
-- Note on implementation: a first attempt wrote the "have I answered"
-- check as a plain correlated subquery against challenge_answers directly
-- inside the policy -- Postgres RLS policies can't safely self-reference
-- their own table that way (42P17 "infinite recursion detected in policy
-- for relation challenge_answers", confirmed live). Moved the check into a
-- SECURITY DEFINER function instead, same pattern this codebase already
-- uses for has_folder_access/has_aircraft_access: the function's internal
-- query runs with RLS bypassed, so it doesn't re-trigger the calling policy.
--
-- Verified live, post-fix: a fresh two-user duel round -- B's raw SELECT
-- while unanswered returns [] (previously returned A's full answer); after
-- B submits their own answer, the same SELECT correctly returns both rows.
-- The real RPC flow (create_challenge / respond_to_challenge /
-- get_next_challenge_question / submit_challenge_answer) is unaffected.
-- ============================================================================

create or replace function public.has_answered_challenge_question(p_question_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from challenge_answers ca2
    where ca2.challenge_question_id = p_question_id
      and ca2.user_id = auth.uid()
  );
$$;

alter policy challenge_answers_participants_read on public.challenge_answers
  using (
    (exists ( select 1
       from (challenge_questions cq
         join challenge_participants cp on ((cp.challenge_id = cq.challenge_id)))
      where ((cq.id = challenge_answers.challenge_question_id) and (cp.user_id = auth.uid()))))
    and (
      challenge_answers.user_id = auth.uid()
      or has_answered_challenge_question(challenge_answers.challenge_question_id)
    )
  );
