-- forfeit_challenge: refuse a forfeit on a duel that is already over.
--
-- THE BUG. forfeit_challenge checked only that the CALLER's participant row is
-- 'active'. finalize_challenge_if_done marks the CHALLENGE completed but never
-- touches challenge_participants, so after a duel finishes every participant
-- row still reads 'active' -- and a forfeit was accepted on a completed duel.
--
-- The result is permanent and self-contradictory: finalize() no-ops (the
-- status is no longer 'active') so user_duel_stats keeps the win, but
-- get_challenge_standings ranks 'forfeited' below every 'active' row, so from
-- then on BOTH players' results screen shows the real winner ranked last and
-- labelled "Forfeited", while the app tells the actual winner they lost.
-- Nothing reverses it.
--
-- WHY THIS IS A SERVER FIX AND NOT JUST A CLIENT ONE. The client route in is
-- challenges/[id].tsx's stale myAnsweredCount: after the LAST answer the count
-- was still questionCount - 1, so `started` stayed true and a player who had
-- just finished got the forfeit prompt on the back button. That is fixed on
-- the client the same day -- but **B39 is already shipped with the bug**, so
-- until users take a new build this guard is the only thing standing between
-- them and a corrupted result. Guards belong on the side that cannot be stale.
--
-- Compare hide_challenge_from_history, which already refuses when a challenge
-- is still active; forfeit_challenge simply never got the mirror-image check.
--
-- Built additively from the LIVE pg_get_functiondef output -- migration files
-- drift from the live DB, and this function in particular has been rewritten
-- more than once (see migrations_fix_duel_forfeit_and_cancel.sql).

CREATE OR REPLACE FUNCTION public.forfeit_challenge(p_challenge_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_answered_count int;
begin
  -- The duel itself must still be running. finalize_challenge_if_done sets
  -- challenges.status = 'completed' but NEVER updates challenge_participants
  -- (verified against the live definition), so every participant of a finished
  -- duel still reads 'active' and sailed straight through the check below.
  if not exists (
    select 1 from challenges where id = p_challenge_id and status = 'active'
  ) then
    raise exception 'This duel is already over';
  end if;

  if not exists (
    select 1 from challenge_participants
    where challenge_id = p_challenge_id and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'Not an active participant in this duel';
  end if;

  select count(*) into v_answered_count
  from challenge_answers ca
  join challenge_questions cq on cq.id = ca.challenge_question_id
  where cq.challenge_id = p_challenge_id and ca.user_id = auth.uid();

  if v_answered_count = 0 then
    raise exception 'You have not answered any questions yet -- cancel the duel instead of forfeiting it';
  end if;

  update challenge_participants
  set status = 'forfeited', responded_at = now()
  where challenge_id = p_challenge_id and user_id = auth.uid();

  perform finalize_challenge_if_done(p_challenge_id);
end;
$function$
;
