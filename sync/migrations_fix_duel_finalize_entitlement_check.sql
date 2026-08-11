-- Duels only ever checked is_premium at create_challenge/respond_to_challenge
-- (accept) time -- nothing re-checked it for the rest of a duel's lifetime.
-- Live-proven exploitable: accept while Premium, then lapse (a real
-- RevenueCat downgrade mid-session needs no re-login -- the JWT is
-- unaffected), and get_next_challenge_question()/submit_challenge_answer()
-- kept working with zero entitlement check, writing a permanent
-- user_duel_stats row and, on a Premium->Pro downgrade specifically, a
-- permanently visible entry on the real get_duels_leaderboard (its own gate
-- is has_pro_access, which Pro satisfies).
--
-- Deliberately NOT gating get_next_challenge_question/submit_challenge_answer
-- themselves -- blocking mid-answer would leave the OTHER participant's duel
-- stuck forever (finalize_challenge_if_done only completes once every active
-- participant has answered every question; a lapsed participant who can no
-- longer submit answers would never satisfy that, holding their opponent's
-- duel open indefinitely for a problem that isn't the opponent's fault).
-- Gameplay proceeds exactly as before. The fix is at the one moment that
-- actually matters for revenue integrity -- finalize_challenge_if_done, the
-- function that writes the permanent record -- re-checking each ranked
-- participant's LIVE is_premium immediately before writing anything for
-- them. A lapsed participant's answers still count as real competition for
-- everyone else's correct-count comparisons (their opponents' results
-- shouldn't change based on a third party's billing status), but no
-- win/loss/tie/coin gets written for the lapsed participant themselves, so
-- nothing illegitimate reaches user_duel_stats or the leaderboards.
--
-- Found in the post-build-31 sweep's cross-feature-interaction pass, live-
-- proven both before (exploit worked) and after (blocked, opponent's own
-- result unaffected) this fix.
CREATE OR REPLACE FUNCTION public.finalize_challenge_if_done(p_challenge_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_total_questions int;
  v_active_count int;
  v_pending_count int;
  v_all_answered_count int;
  v_new_coins text[] := '{}';
  v_wins int;
  v_rank record;
begin
  select count(*) into v_active_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'active';
  select count(*) into v_pending_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'pending';
  select count(*) into v_total_questions from challenge_questions
    where challenge_id = p_challenge_id;

  -- Nobody left to duel: close it out with no winner rather than leaving it
  -- active forever or crowning whoever happened to be first.
  if v_pending_count = 0 and v_active_count < 2 then
    update challenges set status = 'cancelled', completed_at = now()
    where id = p_challenge_id and status = 'active';
    return v_new_coins;
  end if;

  if v_pending_count > 0 or v_total_questions = 0 then
    return v_new_coins;
  end if;

  select count(distinct cp.user_id) into v_all_answered_count
  from challenge_participants cp
  where cp.challenge_id = p_challenge_id and cp.status = 'active'
    and (select count(*) from challenge_answers ca
         join challenge_questions cq on cq.id = ca.challenge_question_id
         where cq.challenge_id = p_challenge_id and ca.user_id = cp.user_id) = v_total_questions;

  if v_all_answered_count <> v_active_count then
    return v_new_coins;
  end if;

  update challenges set status = 'completed', completed_at = now()
  where id = p_challenge_id and status = 'active';
  if not found then
    -- Already finalized by a concurrent call; don't double-award.
    return v_new_coins;
  end if;

  -- Rank every active participant: most correct answers wins outright; ties
  -- are broken only by time on the questions where EVERY member of that
  -- specific tied group answered correctly (a direct N-player generalization
  -- of the 2-player "joint-correct time" rule -- a question you missed never
  -- counts against or for you, and a question someone outside your tied
  -- group missed doesn't touch your tiebreak either).
  for v_rank in
    with active_participants as (
      select cp.user_id from challenge_participants cp
      where cp.challenge_id = p_challenge_id and cp.status = 'active'
    ),
    correct_counts as (
      select ap.user_id,
        (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = p_challenge_id and ca.user_id = ap.user_id and ca.is_correct) as correct_count
      from active_participants ap
    ),
    qualifying_questions as (
      select cc1.user_id, cq.id as question_id
      from correct_counts cc1
      cross join challenge_questions cq
      where cq.challenge_id = p_challenge_id
      and not exists (
        select 1 from correct_counts cc2
        where cc2.correct_count = cc1.correct_count
        and not exists (
          select 1 from challenge_answers ca
          where ca.challenge_question_id = cq.id and ca.user_id = cc2.user_id and ca.is_correct
        )
      )
    ),
    tiebreak_times as (
      select qq.user_id, coalesce(sum(ca.time_ms), 0) as tiebreak_ms
      from qualifying_questions qq
      left join challenge_answers ca on ca.challenge_question_id = qq.question_id and ca.user_id = qq.user_id
      group by qq.user_id
    )
    select cc.user_id, cc.correct_count, coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (order by cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc) as final_rank,
      count(*) over (partition by cc.correct_count, coalesce(tt.tiebreak_ms, 0)) as tie_group_size
    from correct_counts cc
    left join tiebreak_times tt on tt.user_id = cc.user_id
  loop
    -- Revenue-integrity check, added in this migration: skip writing ANY
    -- permanent record for a participant whose Premium has lapsed since
    -- they accepted. Their answers already counted toward everyone ELSE's
    -- correct_count/tiebreak comparisons above (as real competition) --
    -- this only withholds writing something for THEM.
    if not exists (select 1 from user_entitlements ue where ue.user_id = v_rank.user_id and ue.is_premium = true) then
      continue;
    end if;

    if v_rank.final_rank = 1 and v_rank.tie_group_size > 1 then
      insert into user_duel_stats (user_id, ties, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set ties = user_duel_stats.ties + 1, updated_at = now();
    elsif v_rank.final_rank = 1 then
      insert into user_duel_stats (user_id, wins, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set wins = user_duel_stats.wins + 1, updated_at = now()
        returning wins into v_wins;

      if v_wins >= 1 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_FIRST_WIN') then
        insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_FIRST_WIN');
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_FIRST_WIN'); end if;
      end if;
      if v_wins >= 5 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_5_WINS') then
        insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_5_WINS');
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_5_WINS'); end if;
      end if;
      if v_wins >= 25 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_25_WINS') then
        insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_25_WINS');
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_25_WINS'); end if;
      end if;
    else
      insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
    end if;
  end loop;

  return v_new_coins;
end;
$function$;
