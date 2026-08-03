-- ============================================================================
-- Lower "mastered" threshold from 3 correct-in-a-row to 2 -- 2026-08-02
--
-- RC: "let's change the term mastery to two in a row correct - instead of
-- three. otherwise it'll take forever for users to start gaining any % and
-- people will get frustrated. while it is meant to educate, it also has to
-- be fun and engaging. Let's try to boost the function of this feature."
--
-- correct_streak >= 3 was hardcoded in THREE live functions. The first two
-- were easy to find via grep across checked-in migration files; the third
-- (record_study_review's own MASTERY_25/MASTERY_100 coin-award count) has
-- no checked-in migration at all -- same "no migration file" gap already
-- noted for filter_documents -- so it was only found by pulling the live
-- pg_get_functiondef from Supabase directly rather than trusting local
-- files as ground truth. All three are updated together here so the
-- meaning of "mastered" stays consistent everywhere it's used: the Study
-- Mode ring, the Mastery leaderboard, and the mastery coin badges.
-- ============================================================================

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
    ) AS total
  )
  SELECT
    (SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS mastered,
    (SELECT count(*) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS seen,
    avail.total::int AS total_available,
    CASE WHEN avail.total = 0 THEN 0
      ELSE round((SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type)) * 100.0 / avail.total)::int
    END AS pct
  FROM avail;
$function$;

create or replace function public.get_mastery_leaderboard(p_limit integer default 50)
returns table(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total integer;
begin
  select (
    (select count(*) from pcg_terms where definition is not null and definition <> '')
    + (select count(*) from study_far_sections)
    + (select count(*) from aim_paragraphs where body_text is not null and body_text <> '')
    + (select count(*) from advisory_circulars where status = 'active' and description is not null and description <> '' and title is not null and title <> '')
  ) into v_total;

  return query
    select
      u.id,
      coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      count(sp.*) filter (where sp.correct_streak >= 2)::int as mastered,
      count(sp.*)::int as seen,
      v_total as total_available,
      case when v_total = 0 then 0
        else round(count(sp.*) filter (where sp.correct_streak >= 2) * 100.0 / v_total)::int
      end as pct,
      u.id = auth.uid()
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join study_progress sp on sp.user_id = us.user_id
    where us.leaderboard_opt_in = true
    group by u.id, u.raw_user_meta_data, u.email
    having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;

-- record_study_review -- unchanged except v_mastered_count's own threshold
-- (2 instead of 3). Signature is identical to the live version, so this is
-- a true replace, not a new overload (see the PGRST203 gotcha from
-- earlier this session -- only matters when the PARAMETER LIST changes).
create or replace function public.record_study_review(p_item_id text, p_correct boolean, p_item_type text default 'pcg'::text)
returns table(correct_streak integer, next_review_at timestamp with time zone, new_coins text[])
language plpgsql
security definer
as $function$
DECLARE
  v_streak int;
  v_next timestamptz;
  v_today date := current_date;
  v_is_first_ever boolean;
  v_day_streak int;
  v_mastered_count int;
  v_new_coins text[] := '{}';
BEGIN
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

  IF v_day_streak >= 7 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_7') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'STREAK_7');
    v_new_coins := array_append(v_new_coins, 'STREAK_7');
  END IF;
  IF v_day_streak >= 30 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_30') THEN
    INSERT INTO user_coins (user_id, coin_code) VALUES (auth.uid(), 'STREAK_30');
    v_new_coins := array_append(v_new_coins, 'STREAK_30');
  END IF;
  IF v_day_streak >= 90 AND NOT EXISTS (SELECT 1 FROM user_coins WHERE user_id = auth.uid() AND coin_code = 'STREAK_90') THEN
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

  RETURN QUERY SELECT v_streak, v_next, v_new_coins;
END;
$function$;

grant execute on function public.get_study_mastery(text, uuid) to anon, authenticated;
grant execute on function public.get_mastery_leaderboard(integer) to anon, authenticated;
grant execute on function public.record_study_review(text, boolean, text) to anon, authenticated;
