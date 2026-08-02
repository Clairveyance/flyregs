-- ============================================================================
-- Duels fixes, part 2  --  2026-07-31
-- Both found by scripts/duel_e2e_test.py after part 1 landed.
--
-- D5  A decline can now be the event that ends a duel. In a 3-player duel
--     where A and B both finish and C then declines, nobody has an answer
--     left to submit, so the completion check inside submit_challenge_answer
--     never runs again and the duel stays 'active' forever with its results
--     unreachable. (Part 1's pending-gate is correct; the gap is that
--     respond_to_challenge never re-evaluated completion.) Fix: pull the
--     completion + ranking logic into finalize_challenge_if_done() and call
--     it from BOTH submit_challenge_answer and respond_to_challenge.
--
-- D6  A filter combination with no matching content (e.g. Content=AIM +
--     Level=Mechanic, measured at 0 items) created a challenge row with ZERO
--     questions. Both players land in the "waiting for the others to finish"
--     screen permanently -- an unplayable duel that can never complete.
--     Fix: refuse to create it, with a message the UI already surfaces via
--     Alert.alert('Error', err.message). Also pin challenges.question_count
--     to the number of questions ACTUALLY generated, so a short pool doesn't
--     render as "QUESTION 3 OF 5" forever.
-- ============================================================================

-- ---------------------------------------------------------------- D5
-- Returns the coin codes newly awarded to the CALLER (empty if the duel
-- didn't just complete, or the caller wasn't the one who earned them).
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

create or replace function public.submit_challenge_answer(
  p_question_id uuid, p_answer_text text, p_time_ms integer
)
returns table(is_correct boolean, correct_answer text, others_answered_count integer,
              others_total_count integer, challenge_completed boolean, new_coins text[])
language plpgsql
security definer
as $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_active_count int;
begin
  select cq.challenge_id,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      else cq.item_id
    end
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

  new_coins := finalize_challenge_if_done(v_challenge_id);
  select c.status = 'completed' into challenge_completed from challenges c where c.id = v_challenge_id;
  challenge_completed := coalesce(challenge_completed, false);

  return next;
end;
$function$;

create or replace function public.respond_to_challenge(p_challenge_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
as $function$
begin
  if p_accept and not exists (
    select 1 from challenges c where c.id = p_challenge_id and c.status = 'active'
  ) then
    raise exception 'This duel is no longer active';
  end if;

  update challenge_participants
  set status = case when p_accept then 'active' else 'declined' end,
      responded_at = now()
  where challenge_id = p_challenge_id
    and user_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Challenge not found or not pending your response';
  end if;

  -- D5: a decline can be the last event a duel is waiting on -- if everyone
  -- who accepted has already finished, this is what completes it. Also
  -- cancels the duel outright when the last invitee declines.
  if not p_accept then
    perform finalize_challenge_if_done(p_challenge_id);
  end if;
end;
$function$;

-- ---------------------------------------------------------------- D6
create or replace function public.create_challenge(
  p_opponent_ids uuid[], p_question_count integer default 5,
  p_item_types text[] default null, p_levels text[] default null,
  p_category_classes text[] default null
)
returns uuid
language plpgsql
security definer
as $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_i int := 0;
  v_choices text[];
  v_opp uuid;
begin
  if array_length(p_opponent_ids, 1) is null or array_length(p_opponent_ids, 1) < 1 then
    raise exception 'At least one opponent required';
  end if;
  if array_length(p_opponent_ids, 1) > 7 then
    raise exception 'Duels support up to 8 total participants';
  end if;
  if auth.uid() = any(p_opponent_ids) then
    raise exception 'Cannot challenge yourself';
  end if;

  insert into challenges (challenger_id, status, question_count, item_types, levels, category_classes)
  values (auth.uid(), 'active', p_question_count, p_item_types, p_levels, p_category_classes)
  returning id into v_challenge_id;

  insert into challenge_participants (challenge_id, user_id, is_creator, status, responded_at)
  values (v_challenge_id, auth.uid(), true, 'active', now());

  foreach v_opp in array p_opponent_ids loop
    insert into challenge_participants (challenge_id, user_id, is_creator, status)
    values (v_challenge_id, v_opp, false, 'pending')
    on conflict (challenge_id, user_id) do nothing;
  end loop;

  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from pcg_terms
        where (p_levels is null or pcg_knowledge_levels(slug) && p_levels) and definition is not null and definition <> '' and term is not null
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from far_sections f2
        where title is not null and title <> ''
          and (p_levels is null or far_knowledge_levels(f2.part, f2.subpart_letter) is null or far_knowledge_levels(f2.part, f2.subpart_letter) && p_levels)
          and (p_category_classes is null or category_classes_from_text(f2.title) is null or category_classes_from_text(f2.title) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from aim_paragraphs
        where (p_levels is null or aim_knowledge_levels(chapter) && p_levels) and title is not null and title <> ''
          and (p_category_classes is null or category_classes_from_text(coalesce(title, '')) is null or category_classes_from_text(coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from advisory_circulars c2
        where status = 'active' and description is not null and description <> '' and title is not null and title <> ''
          and (p_levels is null or ac_knowledge_levels(c2.subject_series) is null or ac_knowledge_levels(c2.subject_series) && p_levels)
          and (p_category_classes is null or category_classes_from_text(c2.title) is null or category_classes_from_text(c2.title) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    -- Distractors respect the SAME knowledge-level filter as the question
    -- pool. Without this a Student-level duel offered Part 121/125 sections
    -- as decoys, which both gives the answer away by elimination and quizzes
    -- on material the filter exists to exclude. (pcg/aim already did this;
    -- far/ac did not.)
    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_knowledge_levels(slug) && p_levels) and term <> v_item.item_id order by random() limit 5) t;
      when 'far' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and (p_levels is null or far_knowledge_levels(f3.part, f3.subpart_letter) is null or far_knowledge_levels(f3.part, f3.subpart_letter) && p_levels)
              and f3.section_number <> v_item.item_id order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_knowledge_levels(chapter) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and (p_levels is null or ac_knowledge_levels(c3.subject_series) is null or ac_knowledge_levels(c3.subject_series) && p_levels)
              and c3.document_number <> v_item.item_id order by random() limit 5) t;
    end case;

    select array_agg(c order by random()) into v_choices from unnest(v_choices) c;

    insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices)
    values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices);
    v_i := v_i + 1;
  end loop;

  -- D6: no matching content -> don't leave a challenge nobody can ever play.
  if v_i = 0 then
    raise exception 'No questions match those filters. Try widening the Content or Knowledge Level selection.';
  end if;

  -- Short pool: record what actually exists so progress reads "2 OF 2".
  if v_i <> p_question_count then
    update challenges set question_count = v_i where id = v_challenge_id;
  end if;

  return v_challenge_id;
end;
$function$;
