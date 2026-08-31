-- Duel grading, a finalize deadlock, and forgeable streaks (2026-08-31)
--
-- Function bodies below were taken VERBATIM from the live pg_get_functiondef
-- output and diffed line-by-line: zero lines removed, only the additions
-- described here. Not hand-retyped.
--
-- ── 1. HIGH: 8 live duel questions are impossible to answer correctly ─────
-- create_challenge's dictionary fallback builds `choices` from
-- dictionary_terms.term, but submit_challenge_answer resolves the correct
-- answer to cq.item_id -- which for dictionary is the SLUG. So the graded
-- answer is not among the choices at all. Verified live:
--
--   item_id 'hb-effective-pitch'  choices ['Effective pitch', ...]
--   item_id 'wx-general-wind'     choices [..., 'General Wind', ...]
--   item_id 'afh-b-cups'          choices [..., 'CUPS', ...]
--
--   select ... where correct_answer is null and not (resolved = any(choices))
--   -> dictionary: 8, every other item_type: 0
--
-- Proof this is an oversight rather than design: get_challenge_results ALREADY
-- has the dictionary branch and submit_challenge_answer does not -- the type
-- got wired into two of the three item_id->term resolvers. Zero of the 8 have
-- been answered yet, so no W/L record is corrupted; grading happens at submit
-- time, so this retro-fixes all 8 rather than needing a data repair.
--
-- ── 2. MEDIUM: a duel can deadlock permanently on simultaneous final answers ─
-- finalize_challenge_if_done took no lock. Under READ COMMITTED, if two players
-- each insert their last answer and then run the count gate before the other
-- commits, neither sees the other's row, both compute all_answered <> active,
-- and both return -- the duel stays 'active' forever. get_next_challenge_question
-- then returns nothing for either player, so nothing will ever call finalize
-- again: no winner, no stats, no coins, and the only escape is forfeiting.
-- The existing update-where-status='active' guard prevents a DOUBLE award but
-- sits AFTER the gate, so it does nothing for this zero-award race.
--
-- ── 3. HIGH: streaks (and 3 of the 9 coins) are forgeable ────────────────
-- user_streaks is the only gamification table with client DML, and the grant is
-- TABLE-wide while the policy (user_streaks_own_rows, cmd=ALL) is row-level
-- only, with no column restriction. Verified live:
--   has_table_privilege('authenticated','user_streaks','UPDATE') -> TRUE
--   has_table_privilege('authenticated','user_coins','INSERT')   -> FALSE
-- So one PATCH sets any streak value -- and record_study_review awards
-- STREAK_7/30/90 by reading current_streak straight off that column, so
-- current_streak=6 + last_active_date=yesterday + one review mints the badge.
-- Same shape as gotcha_rls_audit_collaborator_escalation_duel_peek #1.
--
-- The client only ever writes three columns (leaderboard.ts: leaderboard_opt_in,
-- stats_visible, current_aircraft), and every other column is defaulted or
-- nullable, so a column-scoped grant is safe. Everything else was checked and
-- is already clean: user_coins INSERT false, user_duel_stats UPDATE false,
-- study_progress UPDATE false, challenge_questions SELECT false.

begin;

CREATE OR REPLACE FUNCTION public.submit_challenge_answer(p_question_id uuid, p_answer_text text, p_time_ms integer)
 RETURNS TABLE(is_correct boolean, correct_answer text, others_answered_count integer, others_total_count integer, challenge_completed boolean, my_set_completed boolean, new_coins text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_active_count int;
  v_total_questions int;
begin
  select cq.challenge_id,
    coalesce(
      cq.correct_answer,  -- real authored answer, denormalized at creation time
      case cq.item_type
        when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
        when 'dictionary' then (select d.term from dictionary_terms d where d.slug = cq.item_id limit 1)
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

  select count(*) into v_total_questions from challenge_questions where challenge_id = v_challenge_id;
  select (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
          where cq.challenge_id = v_challenge_id and ca.user_id = auth.uid()) = v_total_questions
    into my_set_completed;

  new_coins := finalize_challenge_if_done(v_challenge_id);
  select c.status = 'completed' into challenge_completed from challenges c where c.id = v_challenge_id;
  challenge_completed := coalesce(challenge_completed, false);

  return next;
end;
$function$
;

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

-- 3. Column-scope the only client-writable gamification table.
revoke insert, update, delete on public.user_streaks from authenticated;
grant insert (user_id, leaderboard_opt_in, stats_visible, current_aircraft, updated_at)
  on public.user_streaks to authenticated;
grant update (leaderboard_opt_in, stats_visible, current_aircraft, updated_at)
  on public.user_streaks to authenticated;

commit;

-- VERIFY AFTER APPLYING:
--   1. the "answer not in choices" query returns 0 rows for every item_type
--   2. has_table_privilege('authenticated','user_streaks','UPDATE') -> still true
--      (column-level), but a PATCH of current_streak -> 401/403
--   3. leaderboard opt-in toggle still works from the app (Ready Room)
--   4. python3 scripts/duel_e2e_test.py full  -> all checks pass
