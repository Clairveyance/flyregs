-- ============================================================================
-- D10: account deletion mid-duel left the duel stuck forever  -- 2026-07-31
--
-- challenge_participants.user_id cascades from auth.users, so deleting an
-- account silently removes that player from every duel they were in. But
-- completion is only ever re-evaluated inside submit_challenge_answer and
-- respond_to_challenge -- and a deleted user will never call either again.
-- Measured consequence: 2-player duel, creator finished, opponent deletes
-- their account -> the duel stays 'active' with the creator on "waiting on
-- them to finish" permanently. (Same shape as D5, where a decline was the
-- last event a duel was waiting on.)
--
-- Fix: AFTER DELETE trigger on challenge_participants re-runs
-- finalize_challenge_if_done() for the affected challenge. When the
-- CHALLENGER deletes, the whole challenge cascades away instead; finalize
-- then matches zero rows and no-ops, so the trigger is safe on that path too.
-- ============================================================================

create or replace function public.on_participant_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- The challenge may itself be mid-cascade (challenger deleted their
  -- account). finalize handles a missing challenge row by matching nothing.
  perform finalize_challenge_if_done(OLD.challenge_id);
  return OLD;
end;
$function$;

drop trigger if exists challenge_participant_deleted on public.challenge_participants;
create trigger challenge_participant_deleted
  after delete on public.challenge_participants
  for each row execute function public.on_participant_deleted();
