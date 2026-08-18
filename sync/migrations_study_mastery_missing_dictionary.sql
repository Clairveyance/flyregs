-- get_study_mastery() and record_study_review() both compute a corpus-wide
-- "total available" count by summing pcg_terms + far_sections + aim_paragraphs
-- + advisory_circulars -- dictionary_terms was never added to either sum when
-- 'dictionary' was wired into Study Mode (see
-- migrations_dictionary_study_facts_wiring.sql, which extended get_study_queue's
-- fresh_dictionary CTE and create_challenge, but not these two).
--
-- Confirmed live in the function source (pg_get_functiondef), not just
-- speculation: get_study_queue() already serves dictionary cards (fresh_dictionary
-- CTE, same file/migration as above) and record_study_review() already accepts
-- and stores item_type='dictionary' rows in study_progress with no constraint
-- blocking it. But:
--   1. get_study_mastery()'s `avail` CTE has a CASE per item_type that only
--      matches pcg/far/aim/ac -- p_item_type='dictionary' falls through every
--      branch and returns 0, so the study.tsx screen's "N mastered of M
--      reviewed" gauge (which studies/masters dictionary cards fine) divides
--      a real mastered-count numerator by a total_available denominator that
--      silently excludes the entire 6,386-entry dictionary pool -- 2nd-largest
--      of the five (bigger than pcg+far+aim+ac's whole study_far_sections/
--      aim/ac counts combined at the far end, and roughly 10% of the FAR pool
--      alone at the small end) -- which inflates the reported mastery % once
--      any dictionary card is studied, and makes p_item_type='dictionary'
--      explicitly always report 0/0/0% regardless of real progress.
--   2. record_study_review()'s "MASTERY_FULL" ("The Master") coin -- a
--      one-time, non-re-earnable "100% of the entire corpus" achievement --
--      computes its own v_total_available the same way, missing dictionary
--      entirely. A user could earn "The Master" after mastering every
--      pcg/far/aim/ac item while never having reviewed a single dictionary
--      term, which defeats the "big step, thousands of items" intent RC gave
--      this coin (see record_study_review's own MASTERY_FULL comment).
-- Fix: add dictionary_terms to both sums, using the identical eligibility
-- filter get_study_queue's fresh_dictionary / get_study_pool_count already
-- use (category in handbook/mnemonic, first sense has a real definition) so
-- "available" means the same pool in all three functions.

create or replace function public.get_study_mastery(p_item_type text default null::text, p_user_id uuid default null::uuid)
 returns table(mastered integer, seen integer, total_available integer, pct integer)
 language sql
 stable security definer
as $function$
  with target as (
    select coalesce(p_user_id, auth.uid()) as uid
  ),
  avail AS (
    SELECT (
      CASE WHEN p_item_type IS NULL OR p_item_type = 'pcg' THEN
        (SELECT count(*) FROM pcg_terms WHERE definition IS NOT NULL AND definition <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'far' THEN
        (SELECT count(*) FROM study_far_sections) ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'aim' THEN
        (SELECT count(*) FROM aim_paragraphs WHERE body_text IS NOT NULL AND body_text <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'ac' THEN
        (SELECT count(*) FROM advisory_circulars WHERE status = 'active' AND description IS NOT NULL AND description <> '' AND title IS NOT NULL AND title <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'dictionary' THEN
        (SELECT count(*) FROM dictionary_terms WHERE category IN ('handbook', 'mnemonic') AND senses->0->>'definition' IS NOT NULL AND senses->0->>'definition' <> '') ELSE 0 END
    ) AS total
  )
  SELECT
    (SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS mastered,
    (SELECT count(*) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS seen,
    avail.total::int AS total_available,
    CASE WHEN avail.total = 0 THEN 0
      ELSE round((SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type)) * 100.0 / avail.total)::int
    END AS pct
  FROM avail, target
  WHERE public.has_pro_access(target.uid);
$function$;

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

  -- "The Master" -- 100% overall mastery, EVERY item type. v_total_available
  -- must match get_study_mastery()'s own avail.total (p_item_type NULL case)
  -- or this coin can fire before the corpus is actually fully mastered --
  -- dictionary_terms added here for the same reason it was added there (see
  -- migrations_study_mastery_missing_dictionary.sql header): without it, a
  -- user who never touched a single dictionary card could still cross this
  -- "master literally everything" threshold on pcg+far+aim+ac alone.
  SELECT
    (SELECT count(*) FROM pcg_terms WHERE definition IS NOT NULL AND definition <> '')
    + (SELECT count(*) FROM study_far_sections)
    + (SELECT count(*) FROM aim_paragraphs WHERE body_text IS NOT NULL AND body_text <> '')
    + (SELECT count(*) FROM advisory_circulars WHERE status = 'active' AND description IS NOT NULL AND description <> '' AND title IS NOT NULL AND title <> '')
    + (SELECT count(*) FROM dictionary_terms WHERE category IN ('handbook', 'mnemonic') AND senses->0->>'definition' IS NOT NULL AND senses->0->>'definition' <> '')
  INTO v_total_available;
  IF v_total_available > 0 AND v_mastered_count >= v_total_available AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'MASTERY_FULL') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'MASTERY_FULL');
    v_new_coins := array_append(v_new_coins, 'MASTERY_FULL');
  END IF;

  RETURN QUERY SELECT v_streak, v_next, v_new_coins;
END;
$function$;
