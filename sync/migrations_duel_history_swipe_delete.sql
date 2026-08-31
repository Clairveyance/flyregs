-- Swipe-to-delete for Duel history (RC, 2026-08-16): "total W/L count
-- will still show in other areas and on leaderboard, etc., even if duel
-- histories are deleted by user."
--
-- user_duel_stats.wins/losses/ties are already a write-once running total
-- incremented inside finalize_challenge_if_done() -- confirmed live via
-- pg_get_functiondef, NOT recomputed from a live join over `challenges`.
-- So the safe design is a PER-USER soft-hide on challenge_participants
-- (their own row only), never touching challenges/challenge_questions/
-- challenge_answers/user_duel_stats at all: the other participant's view
-- and every aggregate (stats, leaderboard) are completely unaffected, and
-- it's naturally reversible (no data destroyed) even though it reads as
-- "delete" to the user swiping.

alter table public.challenge_participants add column if not exists hidden_at timestamptz;

-- CORRECTED 2026-08-31 -- the claim this comment used to make was FALSE and
-- worth stating plainly, because it overstated client write access:
-- challenge_participants' only policy (challenge_participants_own_rows) is
-- SELECT-only, and authenticated holds no UPDATE grant on the table at all
-- (verified against the LIVE database, not this file -- migration files are
-- known to drift from live here). So a client CANNOT update its own
-- challenge_participants row directly; this RPC is not a convenience, it is
-- the only write path that exists. That is the safer arrangement and should
-- stay that way. It also means the guard below is the real enforcement, not
-- a nicety: it is what makes it impossible to hide a still-'pending' invite
-- on an active duel, which would otherwise strand every other participant
-- forever (finalize_challenge_if_done refuses to complete while any
-- participant is pending). Regression test: scripts/duel_pending_hide_freeze_test.py.
create or replace function public.hide_challenge_from_history(p_challenge_id uuid)
returns void
language plpgsql
security definer
as $function$
begin
  update challenge_participants
  set hidden_at = now()
  where challenge_id = p_challenge_id and user_id = auth.uid();

  if not found then
    raise exception 'Not a participant in this duel';
  end if;
end;
$function$;

create or replace function public.get_my_challenges()
returns table(challenge_id uuid, am_challenger boolean, status text, my_status text, question_count integer, my_answered_count integer, created_at timestamp with time zone, item_types text[], levels text[], category_classes text[], ratings text[], others jsonb)
language plpgsql
security definer
as $function$
begin
  return query
  select
    c.id,
    c.challenger_id = auth.uid(),
    c.status,
    mycp.status,
    c.question_count,
    (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
       where cq.challenge_id = c.id and ca.user_id = auth.uid())::int,
    c.created_at,
    c.item_types,
    c.levels,
    c.category_classes,
    c.ratings,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', ocp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'status', ocp.status,
        'answeredCount', (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = ocp.user_id)
      ) order by ocp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants ocp
      join auth.users u on u.id = ocp.user_id
      left join callsign_registry cr on cr.user_id = ocp.user_id
      where ocp.challenge_id = c.id and ocp.user_id != auth.uid()
    )
  from challenges c
  -- hidden_at is null -- the only change from before: a challenge this
  -- user swiped away from THEIR OWN history stops appearing in THEIR
  -- OWN get_my_challenges() call. The other participant's own row (and
  -- thus their own call to this same function) is untouched.
  join challenge_participants mycp on mycp.challenge_id = c.id and mycp.user_id = auth.uid() and mycp.hidden_at is null
  order by c.created_at desc;
end;
$function$;
