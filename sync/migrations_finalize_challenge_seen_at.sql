-- Companion to migrations_duel_coin_toast_fix.sql: the caller's OWN coin
-- (the one already returned in v_new_coins for the immediate client-side
-- reveal) must be marked seen_at=now() at insert time, or the next
-- get_unseen_coins() check would show it AGAIN as if it were new. Every
-- OTHER participant's coin stays seen_at NULL, exactly as before, so the
-- unseen-check picks those up whenever that player next opens Duels.
-- Only the seen_at values on the 3 insert statements changed; every other
-- line is byte-identical to the live function (diffed before applying).

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
    return v_new_coins;
  end if;

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

      -- seen_at: set immediately for the calling user (whose client shows
      -- the reveal synchronously via this function's own return value),
      -- left NULL for anyone else (picked up later by get_unseen_coins()).
      if v_wins >= 1 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_FIRST_WIN') then
        insert into user_coins (user_id, coin_code, seen_at) values (v_rank.user_id, 'DUEL_FIRST_WIN', case when auth.uid() = v_rank.user_id then now() else null end);
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_FIRST_WIN'); end if;
      end if;
      if v_wins >= 5 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_5_WINS') then
        insert into user_coins (user_id, coin_code, seen_at) values (v_rank.user_id, 'DUEL_5_WINS', case when auth.uid() = v_rank.user_id then now() else null end);
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_5_WINS'); end if;
      end if;
      if v_wins >= 25 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_25_WINS') then
        insert into user_coins (user_id, coin_code, seen_at) values (v_rank.user_id, 'DUEL_25_WINS', case when auth.uid() = v_rank.user_id then now() else null end);
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
