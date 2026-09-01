-- A duel with zero active participants hung forever (2026-08-31)
--
-- Reachable with no race at all: A challenges B, A answers at least one
-- question, B never taps Accept or Decline. A cannot cancel (cancel_challenge
-- raises once answered_count > 0: "You have already started this duel --
-- forfeit it instead"), and forfeiting sets A's own participant status but
-- never finalizes, because finalize_challenge_if_done short-circuits on
-- `v_pending_count > 0`. The duel stays 'active' forever, so A is locked out
-- of it (get_next_challenge_question requires an active challenge, which it
-- still is), gets no result, no W/L, no coins, and has no way to clear it.
--
-- Live state check: 34 challenges are currently pinned open this way, though
-- all 34 involve only @flyregs.invalid test accounts from a single harness run
-- on 2026-08-28 -- ZERO involve a real user. So this is a real structural gap
-- that has not yet bitten anyone, not a live incident.
--
-- Fix adds a branch BEFORE the pending short-circuit: if no participant is
-- active any more, nobody can ever finish, so close the duel as cancelled.
-- Whether an invitee ever responded is irrelevant at that point.
--
-- This is deliberately NOT a duel timeout. There is still no expiry anywhere
-- (cron.job has one entry, unrelated; challenges has no expires_at), so an
-- un-responded invite still pins a duel open while the creator is ACTIVE.
-- Whether invites should expire, and after how long, is a product decision
-- for RC -- not something to guess at in a migration.
--
-- Body taken verbatim from live pg_get_functiondef; diffed, zero lines removed.

begin;

CREATE OR REPLACE FUNCTION public.finalize_challenge_if_done(p_challenge_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_total_questions int;
  v_active_count int;
  v_pending_count int;
  v_forfeited_count int;
  v_all_answered_count int;
  v_new_coins text[] := '{}';
  v_wins int;
  v_rank record;
begin
  -- Serialize concurrent finalize attempts. Without this, two players
  -- submitting their last answer at the same moment each run the count gate
  -- on a snapshot taken before the other committed, both see
  -- all_answered <> active, and BOTH return -- leaving the duel 'active'
  -- forever with no winner, no stats and no coins. The existing
  -- update-where-status='active' guard prevents a DOUBLE award but sits
  -- after the gate, so it does nothing for this zero-award race.
  perform 1 from challenges where id = p_challenge_id for update;
  select count(*) into v_active_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'active';
  select count(*) into v_pending_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'pending';
  select count(*) into v_forfeited_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'forfeited';
  select count(*) into v_total_questions from challenge_questions
    where challenge_id = p_challenge_id;

  -- Nobody is actively playing any more. Added 2026-08-31: this case used to
  -- fall through to the `v_pending_count > 0` short-circuit below and hang
  -- FOREVER. Reachable without any race: A challenges B, A answers at least
  -- one question, B never taps Accept or Decline. A can no longer cancel
  -- (cancel_challenge refuses once answered_count > 0) and forfeiting sets A's
  -- own status but never finalizes, because B is still 'pending'. A is then
  -- locked out -- get_next_challenge_question requires status 'active', which
  -- it still is -- with no result and no stats, and no way out. A duel with
  -- zero active participants can never complete by definition, so close it as
  -- cancelled. Deliberately placed BEFORE the pending check: whether an
  -- invitee ever responded is irrelevant once nobody is left to play.
  if v_active_count = 0 then
    update challenges set status = 'cancelled', completed_at = now()
    where id = p_challenge_id and status = 'active';
    return v_new_coins;
  end if;

  if v_pending_count = 0 and v_active_count < 2 then
    if not (v_active_count = 1 and v_forfeited_count > 0) then
      -- Nobody left actively playing and nobody forfeited to get here
      -- (everyone simply declined, or the last account got deleted):
      -- close it out with no winner, same as always.
      update challenges set status = 'cancelled', completed_at = now()
      where id = p_challenge_id and status = 'active';
      return v_new_coins;
    end if;
    -- else: exactly one active participant survives a real forfeit --
    -- fall through to scoring below and finalize them as the winner right
    -- now, without waiting on them to answer anything further.
  elsif v_pending_count > 0 or v_total_questions = 0 then
    return v_new_coins;
  else
    -- 2+ active participants, nobody pending: only finalize once every
    -- ACTIVE (non-forfeited) participant has answered every question. A
    -- forfeited participant is deliberately excluded from this gate --
    -- they've dropped out and will never answer the rest, same reasoning
    -- 'declined' already gets.
    select count(distinct cp.user_id) into v_all_answered_count
    from challenge_participants cp
    where cp.challenge_id = p_challenge_id and cp.status = 'active'
      and (select count(*) from challenge_answers ca
           join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = p_challenge_id and ca.user_id = cp.user_id) = v_total_questions;

    if v_all_answered_count <> v_active_count then
      return v_new_coins;
    end if;
  end if;

  update challenges set status = 'completed', completed_at = now()
  where id = p_challenge_id and status = 'active';
  if not found then
    -- Already finalized by a concurrent call; don't double-award.
    return v_new_coins;
  end if;

  -- Rank every active-or-forfeited participant: an 'active' participant
  -- always outranks a 'forfeited' one regardless of correct_count (the
  -- `case when status='forfeited' then 1 else 0 end` tier, sorted first);
  -- within the same tier, most correct answers wins, ties broken by time
  -- on jointly-correct questions -- identical to the pre-existing rule,
  -- just partitioned by tier too so a forfeiter's own correct-count can't
  -- leak into an active player's tiebreak group or vice versa.
  for v_rank in
    with scored_participants as (
      select cp.user_id, cp.status from challenge_participants cp
      where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
    ),
    correct_counts as (
      select sp.user_id, sp.status,
        (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = p_challenge_id and ca.user_id = sp.user_id and ca.is_correct) as correct_count
      from scored_participants sp
    ),
    qualifying_questions as (
      select cc1.user_id, cq.id as question_id
      from correct_counts cc1
      cross join challenge_questions cq
      where cq.challenge_id = p_challenge_id
      and not exists (
        select 1 from correct_counts cc2
        where cc2.correct_count = cc1.correct_count and cc2.status = cc1.status
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
    select cc.user_id, cc.status, cc.correct_count, coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (
        order by (case when cc.status = 'forfeited' then 1 else 0 end),
                 cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc
      ) as final_rank,
      count(*) over (
        partition by (case when cc.status = 'forfeited' then 1 else 0 end), cc.correct_count, coalesce(tt.tiebreak_ms, 0)
      ) as tie_group_size
    from correct_counts cc
    left join tiebreak_times tt on tt.user_id = cc.user_id
  loop
    -- Revenue-integrity check (unchanged from migrations_fix_duel_finalize_
    -- entitlement_check.sql): skip writing ANY permanent record for a
    -- participant whose Premium has lapsed since they accepted.
    if not exists (select 1 from user_entitlements ue where ue.user_id = v_rank.user_id and ue.is_premium = true) then
      continue;
    end if;

    if v_rank.status = 'forfeited' then
      -- Forfeiting is always a loss, never a tie/win -- even if a
      -- forfeiter numerically ties another forfeiter, neither of them beat
      -- anyone who stayed active.
      insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
    elsif v_rank.final_rank = 1 and v_rank.tie_group_size > 1 then
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
      -- Re-added, missing since the forfeit-and-cancel rewrite (see this
      -- migration's own header comment) -- "The Ace," trophy-case only,
      -- same one-time NOT-EXISTS pattern as the three above.
      if v_wins >= 100 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_100_WINS') then
        insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_100_WINS');
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_100_WINS'); end if;
      end if;
    else
      insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
    end if;
  end loop;

  return v_new_coins;
end;
$function$
;

commit;

-- VERIFY: python3 scripts/duel_e2e_test.py full -> all checks pass
