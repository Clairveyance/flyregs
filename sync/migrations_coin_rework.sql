-- Challenge Coins rework, 2026-08-12 (RC, screenshot of the Profile coin
-- grid, every earned coin showing a badge that just says "1"):
--
-- Every award path checked `NOT EXISTS (... WHERE user_id=... AND
-- coin_code=...)` before inserting, so a coin could never structurally be
-- earned more than once -- the "1" was technically accurate, just
-- permanently frozen. Asked RC which coins should actually behave that
-- way. Answer:
--   - The 3 "currency" streak coins (STREAK_7/30/90) already borrow the
--     real-FAA-currency framing (coins.ts's own comment on STREAK_90).
--     Real currency lapses and gets re-established -- these should too:
--     break your streak, rebuild it past the threshold again, get a new
--     coin, real running count.
--   - Every other coin (FIRST_REP, MASTERY_25/100, DUEL_FIRST_WIN/5_WINS/
--     25_WINS) stays a genuine one-time milestone -- drop the frozen "1"
--     badge instead (client-side change, see profile/[userId].tsx).
--   - Two new "trophy case" coins, deliberately NOT part of the regular
--     3-per-row grid: DUEL_100_WINS ("The Ace") and MASTERY_FULL ("The
--     Master", 100% overall mastery across every item type -- the same
--     cross-type total get_study_mastery() already reports). Both
--     one-time, same NOT-EXISTS pattern as the rest of the one-time set.

-- user_coins had PRIMARY KEY (user_id, coin_code) -- structurally the exact
-- reason a coin could never repeat; any second INSERT for the same pair
-- would fail the PK outright, no app-level guard needed OR possible to work
-- around without this change. Surrogate id instead, so STREAK_7/30/90 can
-- carry multiple rows (one per real re-earn) while every other coin_code
-- still naturally ends up with exactly one row -- their award logic below
-- is untouched, still NOT-EXISTS-gated, the schema no longer forces it.
alter table public.user_coins drop constraint user_coins_pkey;
alter table public.user_coins add column id uuid primary key default gen_random_uuid();
-- Replaces the lookup index the old PK provided for free -- every award
-- check and both read RPCs filter on this pair constantly.
create index if not exists idx_user_coins_user_code on public.user_coins(user_id, coin_code);

create or replace function public.record_study_review(p_item_id text, p_correct boolean, p_item_type text default 'pcg'::text)
 returns table(correct_streak integer, next_review_at timestamp with time zone, new_coins text[])
 language plpgsql
 security definer
as $function$
declare
  v_streak int;
  v_next timestamptz;
  v_today date := current_date;
  v_is_first_ever boolean;
  v_day_streak int;
  v_mastered_count int;
  v_total_available int;
  v_new_coins text[] := '{}';
begin
  v_is_first_ever := NOT EXISTS (SELECT 1 FROM study_progress WHERE user_id = auth.uid());

  INSERT INTO study_progress (user_id, item_type, item_id, correct_streak, total_reviews, total_correct, last_reviewed_at, next_review_at)
  VALUES (auth.uid(), p_item_type, p_item_id, CASE WHEN p_correct THEN 1 ELSE 0 END, 1, CASE WHEN p_correct THEN 1 ELSE 0 END, now(), now() + CASE WHEN p_correct THEN interval '1 day' ELSE interval '10 minutes' END)
  ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET
    correct_streak = CASE WHEN p_correct THEN study_progress.correct_streak + 1 ELSE 0 END,
    total_reviews = study_progress.total_reviews + 1,
    total_correct = study_progress.total_correct + CASE WHEN p_correct THEN 1 ELSE 0 END,
    last_reviewed_at = now(),
    next_review_at = CASE
      WHEN p_correct THEN now() + (LEAST(60, POWER(2, LEAST(study_progress.correct_streak + 1, 6))) || ' days')::interval
      ELSE now() + interval '10 minutes'
    END
  RETURNING study_progress.correct_streak, study_progress.next_review_at INTO v_streak, v_next;

  INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date, updated_at)
  VALUES (auth.uid(), 1, 1, v_today, now())
  ON CONFLICT (user_id) DO UPDATE SET
    current_streak = CASE
      WHEN user_streaks.last_active_date = v_today THEN user_streaks.current_streak
      WHEN user_streaks.last_active_date = v_today - 1 THEN user_streaks.current_streak + 1
      ELSE 1
    END,
    longest_streak = GREATEST(
      user_streaks.longest_streak,
      CASE
        WHEN user_streaks.last_active_date = v_today THEN user_streaks.current_streak
        WHEN user_streaks.last_active_date = v_today - 1 THEN user_streaks.current_streak + 1
        ELSE 1
      END
    ),
    last_active_date = v_today,
    updated_at = now()
  RETURNING user_streaks.current_streak INTO v_day_streak;

  IF v_is_first_ever AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'FIRST_REP') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'FIRST_REP');
    v_new_coins := array_append(v_new_coins, 'FIRST_REP');
  END IF;

  -- Re-earnable now: `= N` (the exact day the streak CROSSES the
  -- threshold) instead of `>= N` (true every day forever after), which
  -- would otherwise fire on every single review once the streak passes the
  -- mark. current_streak only advances once per calendar day (see the
  -- CASE above -- unchanged if last_active_date is already today), so `= N`
  -- is guaranteed to be true on exactly one real calendar day per streak
  -- cycle, whether this is the user's first time through or their fifth.
  -- The NOT-EXISTS guard moves from "ever" to "already earned TODAY" --
  -- still blocks a duplicate from two reviews on the same crossing day,
  -- but no longer blocks a later cycle after the streak has broken and
  -- climbed back up.
  IF v_day_streak = 7 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_7' AND earned_at::date = v_today) THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'STREAK_7');
    v_new_coins := array_append(v_new_coins, 'STREAK_7');
  END IF;
  IF v_day_streak = 30 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_30' AND earned_at::date = v_today) THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'STREAK_30');
    v_new_coins := array_append(v_new_coins, 'STREAK_30');
  END IF;
  IF v_day_streak = 90 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_90' AND earned_at::date = v_today) THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'STREAK_90');
    v_new_coins := array_append(v_new_coins, 'STREAK_90');
  END IF;

  SELECT count(*) INTO v_mastered_count FROM study_progress sp WHERE sp.user_id = auth.uid() AND sp.correct_streak >= 2;
  IF v_mastered_count >= 25 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'MASTERY_25') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'MASTERY_25');
    v_new_coins := array_append(v_new_coins, 'MASTERY_25');
  END IF;
  IF v_mastered_count >= 100 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'MASTERY_100') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'MASTERY_100');
    v_new_coins := array_append(v_new_coins, 'MASTERY_100');
  END IF;

  -- "The Master" -- 100% overall mastery, every item type, same total
  -- get_study_mastery() reports as `total_available` (its own `avail.total`
  -- CTE, duplicated here rather than called out to since that function is
  -- STABLE/read-only and this needs the number inline in one INSERT-side
  -- transaction). A real "big step" per RC -- thousands of items, one-time,
  -- same NOT-EXISTS pattern as MASTERY_25/100 above, not re-earnable like
  -- the currency coins (losing and rebuilding 100% isn't the same kind of
  -- lapse a daily streak has).
  SELECT
    (SELECT count(*) FROM pcg_terms WHERE definition IS NOT NULL AND definition <> '')
    + (SELECT count(*) FROM study_far_sections)
    + (SELECT count(*) FROM aim_paragraphs WHERE body_text IS NOT NULL AND body_text <> '')
    + (SELECT count(*) FROM advisory_circulars WHERE status = 'active' AND description IS NOT NULL AND description <> '' AND title IS NOT NULL AND title <> '')
  INTO v_total_available;
  IF v_total_available > 0 AND v_mastered_count >= v_total_available AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'MASTERY_FULL') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'MASTERY_FULL');
    v_new_coins := array_append(v_new_coins, 'MASTERY_FULL');
  END IF;

  RETURN QUERY SELECT v_streak, v_next, v_new_coins;
END;
$function$;

create or replace function public.finalize_challenge_if_done(p_challenge_id uuid)
 returns text[]
 language plpgsql
 security definer
as $function$
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
      -- "The Ace" -- trophy-case coin, not part of the regular 3-per-row
      -- grid (see coins.ts's TROPHY_CATALOG). Same one-time NOT-EXISTS
      -- pattern as every other duel-win coin above.
      if v_wins >= 100 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_100_WINS') then
        insert into user_coins (user_id, coin_code, seen_at) values (v_rank.user_id, 'DUEL_100_WINS', case when auth.uid() = v_rank.user_id then now() else null end);
        if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_100_WINS'); end if;
      end if;
    else
      insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
    end if;
  end loop;

  return v_new_coins;
end;
$function$;
