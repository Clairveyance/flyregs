-- Real production bug found 2026-08-14 during the RC-requested full
-- gating/paywall/loopholes re-sweep (triggered by the SAME-DAY isPro-vs-
-- hasProAccess bug pattern found and fixed three times already: study.tsx,
-- and (per the client-side sibling of this fix) search.tsx's openStudy() /
-- ready-room.tsx). This one is the mirror-image DOWN-direction bug in the
-- same feature area: get_study_queue() already has a has_pro_access() gate
-- (see migrations_fix_get_study_queue_missing_pro_gate.sql, 2026-08-12) and
-- so do get_study_pool_count()/get_study_mastery()/get_currency() -- but
-- record_study_review(), the RPC that actually WRITES study_progress,
-- advances user_streaks, and AWARDS real Challenge Coins (FIRST_REP,
-- STREAK_7/30/90, MASTERY_25/100, MASTERY_FULL), has never had any tier
-- check in its live definition, including in migrations_coin_rework.sql
-- (the migration that most recently rewrote its coin-award logic) -- this
-- was not a regression from that rework, the gate appears to have simply
-- never existed.
--
-- Confirmed via pg_get_functiondef against the live function (not just a
-- stale migration file, per this repo's own "migration files drift from
-- live DB" gotcha): no has_pro_access()/is_pro/is_premium reference
-- anywhere in the body. record_study_review is SECURITY DEFINER and
-- user_coins/study_progress/user_streaks correctly have no direct
-- INSERT/UPDATE grant to anon/authenticated (confirmed via
-- information_schema.role_table_grants) -- so a client can't forge a coin
-- by writing the tables directly. But this RPC itself IS the sanctioned
-- write path, and it was reachable by ANY authenticated caller regardless
-- of tier: a Free or Plus (non-Pro) account calling record_study_review
-- directly (bypassing study.tsx's client-side hasProAccess gate entirely,
-- e.g. via a raw RPC/curl call) could build real spaced-repetition
-- progress AND genuinely earn every Challenge Coin in the catalog for
-- free -- badges that then render on their public profile
-- (profile/[userId].tsx) exactly as if honestly earned by a paying
-- subscriber. This is the exact "lower tier user accessing upper tier
-- content via raw API" shape RC's re-sweep instruction called out.
--
-- Fix: same has_pro_access() gate every sibling Study Mode RPC already
-- uses, as a hard exception (matching create_challenge/
-- respond_to_challenge's own "raise exception" pattern for a write RPC,
-- rather than get_study_queue's silent-empty read-RPC pattern) --
-- non-Pro callers get a clean error, which study.tsx's own recordStudyReview
-- call already wraps in a best-effort .catch(() => {}) (never blocks the
-- study flow on a network blip), so this fails exactly as gracefully as any
-- other transient error would client-side. Pro/Premium callers see zero
-- behavior change -- every line below the new check is byte-for-byte the
-- prior live definition.

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
  if not public.has_pro_access() then
    raise exception 'Study Mode requires Pro';
  end if;

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
