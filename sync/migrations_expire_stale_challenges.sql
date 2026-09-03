-- Auto-end duels that have been abandoned. RC, 2026-09-02:
-- "24 hours only, and then it's a forfeit and the other person automatically
--  wins and you get a loss."
--
-- THE BUG THIS CLOSES. finalize_challenge_if_done() only completes a duel once
-- EVERY still-active participant has answered every question, and there is no
-- timeout anywhere -- verified live, cron.job contains exactly one job
-- (refresh_search_popularity) and nothing else. So a duel where one player
-- simply stops playing never ends. The player who FINISHED is stuck: the only
-- exit is swipe-delete, which forfeits, recording a loss for them and a win
-- for the person who quit. This is the mechanism behind RC's own 2026-08-22
-- report ("started-then-left should auto-win the other player").
--
-- A single unanswered INVITE freezes it the same way: the `elsif
-- v_pending_count > 0` branch returns early, so with active=2/pending=1 the
-- duel never finalizes even after everyone who accepted has finished.
--
-- THE RULE, as specified: 24 hours of inactivity.
--   (a) never responded to the invite      -> declined, no loss. They never
--                                             played; a loss would be unfair
--                                             and would also mean an invite
--                                             could damage someone's record.
--   (b) accepted but never answered one Q  -> declined, no loss. Same
--                                             reasoning, and it matches
--                                             cancel_challenge's existing
--                                             "answered nothing = no penalty".
--   (c) answered at least one, then walked -> FORFEIT. This is RC's rule
--                                             exactly: they started, so they
--                                             take the loss and the others
--                                             play on for the win.
--
-- The 24 hours is measured from the player's OWN last action, not from when
-- the duel was created, so a slow-but-active duel is never killed.
--
-- Safe to run from cron: finalize_challenge_if_done uses auth.uid() ONLY to
-- decide whether to append to its returned new_coins array, never to gate the
-- write. Coins still land, and get_unseen_coins() already exists to reveal
-- them late -- it was built for exactly this "awarded while you weren't
-- looking" case.

create or replace function public.expire_stale_challenges()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c record;
  v_changed integer := 0;
  v_cutoff timestamptz := now() - interval '24 hours';
begin
  -- (a) invite never answered
  update challenge_participants cp
     set status = 'declined', responded_at = now()
    from challenges c
   where c.id = cp.challenge_id
     and c.status = 'active'
     and cp.status = 'pending'
     and cp.invited_at < v_cutoff;
  get diagnostics v_changed = row_count;

  -- (b) accepted, never answered a single question
  update challenge_participants cp
     set status = 'declined', responded_at = now()
    from challenges c
   where c.id = cp.challenge_id
     and c.status = 'active'
     and cp.status = 'active'
     and cp.is_creator = false
     and coalesce(cp.responded_at, cp.invited_at) < v_cutoff
     and not exists (
       select 1 from challenge_answers ca
         join challenge_questions cq on cq.id = ca.challenge_question_id
        where cq.challenge_id = c.id and ca.user_id = cp.user_id);

  -- (c) started, then walked away -> forfeit
  update challenge_participants cp
     set status = 'forfeited', responded_at = now()
    from challenges c
   where c.id = cp.challenge_id
     and c.status = 'active'
     and cp.status = 'active'
     and (select count(*) from challenge_answers ca
            join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = cp.user_id)
         < (select count(*) from challenge_questions cq3 where cq3.challenge_id = c.id)
     and (select max(ca.answered_at) from challenge_answers ca
            join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = cp.user_id) < v_cutoff;

  -- Let the existing finalizer decide the outcome for every touched duel.
  for v_c in select id from challenges where status = 'active' loop
    perform finalize_challenge_if_done(v_c.id);
  end loop;

  return v_changed;
end;
$$;

-- Cron-only. No client ever calls this.
revoke execute on function public.expire_stale_challenges() from public, anon, authenticated;

-- Hourly, so a 24h deadline is honoured within the hour rather than once a day.
select cron.unschedule('expire_stale_challenges')
 where exists (select 1 from cron.job where jobname = 'expire_stale_challenges');
select cron.schedule('expire_stale_challenges', '23 * * * *',
                     $$select public.expire_stale_challenges();$$);
