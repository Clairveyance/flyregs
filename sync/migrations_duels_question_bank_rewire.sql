-- Rewires Duels to draw from the authored question bank (study_facts, with
-- real distractors) instead of always the "match the title to its section
-- number" mechanic -- RC's approved $72 authoring pass, task "Rewire Duels
-- to pull from the new question bank instead of raw titles."
--
-- Ships as a SAFE, per-item FALLBACK, not a hard cutover: right now (this
-- migration's own apply time) there are ZERO study_facts rows with
-- status='live' AND real distractors -- the AIM authoring batch just
-- finished with 1,841 real facts, but they're still 'pending' until the
-- separate Haiku verify pass (already submitted, in progress) promotes them
-- to 'live'; FAR and AC's own authoring batches are still running entirely.
-- Confirmed via direct query before writing this: distractors IS NOT NULL
-- exists on exactly 1,841 rows total right now, all status='pending'. That
-- means every branch below falls through to the EXACT same "old
-- title-matching" behavior Duels already has today, for every type, right
-- up until this migration is applied -- and it upgrades itself
-- automatically and incrementally as each type's batch finishes and gets
-- verified, with no further migration or deploy needed. Safe to ship now.
--
-- PCG is deliberately untouched -- the question-bank authoring pass never
-- covered PCG (it uses its own separate quiz_prompt_condense() mechanism,
-- a different design already in place, not in scope for this rewire).
--
-- New challenge_questions columns:
--   fact_id          -- set only when this question came from a real
--                        authored study_facts row. NULL means "old-style":
--                        get_next_challenge_question/submit_challenge_answer
--                        fall back to their exact pre-existing behavior.
--   question         -- denormalized at creation time (like choices already
--                        are), not looked up live -- a duel's own historical
--                        record must stay exactly what the player actually
--                        saw and answered, even if study_facts.question is
--                        later corrected by a future verify pass.
--   correct_answer   -- same denormalization reasoning as question.
alter table public.challenge_questions
  add column if not exists fact_id uuid references public.study_facts(id),
  add column if not exists question text,
  add column if not exists correct_answer text;

CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_fact record;
  v_i int := 0;
  v_choices text[];
  v_opp uuid;
  v_used_fact_ids uuid[] := array[]::uuid[];
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  if array_length(p_opponent_ids, 1) is null or array_length(p_opponent_ids, 1) < 1 then
    raise exception 'At least one opponent required';
  end if;
  if array_length(p_opponent_ids, 1) > 7 then
    raise exception 'Duels support up to 8 total participants';
  end if;
  if auth.uid() = any(p_opponent_ids) then
    raise exception 'Cannot challenge yourself';
  end if;
  if exists (
    select 1 from unnest(p_opponent_ids) opp_id
    where not exists (
      select 1 from user_streaks us where us.user_id = opp_id and us.leaderboard_opt_in = true
    )
  ) then
    raise exception 'One or more selected opponents are not available to challenge';
  end if;

  insert into challenges (challenger_id, status, question_count, item_types, levels, category_classes, ratings)
  values (auth.uid(), 'active', p_question_count, p_item_types, p_levels, p_category_classes, p_ratings)
  returning id into v_challenge_id;

  insert into challenge_participants (challenge_id, user_id, is_creator, status, responded_at)
  values (v_challenge_id, auth.uid(), true, 'active', now());

  foreach v_opp in array p_opponent_ids loop
    insert into challenge_participants (challenge_id, user_id, is_creator, status)
    values (v_challenge_id, v_opp, false, 'pending')
    on conflict (challenge_id, user_id) do nothing;
  end loop;

  -- D7/D8: every branch draws from quizzable_*, so the prompt always has
  -- exactly one correct answer. PCG/FAR/AIM draw a 3x candidate slice vs.
  -- AC's 1x (see header) -- the final `order by random() limit
  -- p_question_count` below picks proportionally from whatever's in the
  -- combined pool. FAR/AC additionally exclude 'not_applicable' content
  -- unconditionally and weight the candidate slice toward higher
  -- ACS/PTS-citation-density items (2026-08-11) -- real relevance signal,
  -- not a guess, same weighting scheme as get_study_queue.
  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from quizzable_pcg_terms
        where (p_levels is null or pcg_knowledge_levels(slug) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
          and (p_ratings is null or pcg_ratings(term) is null or pcg_ratings(term) && p_ratings)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where not (far_knowledge_levels(f2.part, f2.subpart_letter) && array['not_applicable'])
          and (p_levels is null or far_knowledge_levels(f2.part, f2.subpart_letter) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
          and (p_ratings is null or far_ratings(f2.part, f2.section_number) is null or far_ratings(f2.part, f2.section_number) && p_ratings)
        order by (far_relevance_weight(f2.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_knowledge_levels(chapter, paragraph_number) && p_levels)
          and (p_category_classes is null or aim_category_classes(chapter, coalesce(title, '')) is null or aim_category_classes(chapter, coalesce(title, '')) && p_category_classes)
          and (p_ratings is null or aim_ratings(chapter, paragraph_number) is null or aim_ratings(chapter, paragraph_number) && p_ratings)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from quizzable_advisory_circulars c2
        where not (ac_knowledge_levels(c2.subject_series) && array['not_applicable'])
          and (p_levels is null or ac_knowledge_levels(c2.subject_series) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
          and (p_ratings is null or ac_ratings(c2.subject_series) is null or ac_ratings(c2.subject_series) && p_ratings)
        order by (ac_relevance_weight(c2.document_number) + 1) * random() desc limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    -- Real question-bank fact first, for far/aim/ac only (pcg never
    -- authored) -- same item_id, matched on a currently-live, verified,
    -- distractor-bearing row. Falls through to the pre-existing
    -- title-matching path below whenever none exists yet for this
    -- specific item_id (the overwhelmingly common case until each type's
    -- authoring pass finishes and gets verified).
    v_fact := null;
    if v_item.item_type in ('far', 'aim', 'ac') then
      select sf.* into v_fact
      from study_facts sf
      where sf.item_type = v_item.item_type
        and sf.item_id = v_item.item_id
        and sf.status = 'live'
        and sf.distractors is not null
        and array_length(sf.distractors, 1) = 3
        and not (sf.id = any(v_used_fact_ids))
      order by random()
      limit 1;
    end if;

    if v_fact.id is not null then
      v_used_fact_ids := array_append(v_used_fact_ids, v_fact.id);
      select array_agg(c order by random()) into v_choices
      from unnest(array_cat(array[v_fact.answer], v_fact.distractors)) c;

      insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices, fact_id, question, correct_answer)
      values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices, v_fact.id, v_fact.question, v_fact.answer);
      v_i := v_i + 1;
      continue;
    end if;

    -- No verified authored fact for this item yet -- pre-existing
    -- "match the title to its own identifier" mechanic, unchanged.
    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_knowledge_levels(slug) && p_levels) and term <> v_item.item_id order by random() limit 5) t;
      when 'far' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_knowledge_levels(f3.part, f3.subpart_letter) && p_levels)
              and f3.section_number <> v_item.item_id order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_knowledge_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and not (ac_knowledge_levels(c3.subject_series) && array['not_applicable'])
              and (p_levels is null or ac_knowledge_levels(c3.subject_series) && p_levels)
              and c3.document_number <> v_item.item_id order by random() limit 5) t;
    end case;

    select array_agg(c order by random()) into v_choices from unnest(v_choices) c;

    insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices)
    values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices);
    v_i := v_i + 1;
  end loop;

  if v_i = 0 then
    raise exception 'No questions match those filters. Try widening the Content or Knowledge Level selection.';
  end if;

  if v_i <> p_question_count then
    update challenges set question_count = v_i where id = v_challenge_id;
  end if;

  return v_challenge_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_challenge_question(p_challenge_id uuid)
 RETURNS TABLE(question_id uuid, sort_order integer, item_type text, prompt text, choices text[], already_answered boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select cq.id, cq.sort_order, cq.item_type,
    coalesce(
      cq.question,  -- real authored question, denormalized at creation time
      case cq.item_type
        when 'pcg' then (select quiz_prompt_condense(pt.definition) from pcg_terms pt where pt.term = cq.item_id limit 1)
        when 'far' then (select regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') from far_sections f where f.section_number = cq.item_id)
        when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
        when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
      end
    ),
    cq.choices,
    exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  from challenge_questions cq
  where cq.challenge_id = p_challenge_id
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and not exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  order by cq.sort_order
  limit 1;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_challenge_answer(p_question_id uuid, p_answer_text text, p_time_ms integer)
 RETURNS TABLE(is_correct boolean, correct_answer text, others_answered_count integer, others_total_count integer, challenge_completed boolean, new_coins text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_active_count int;
begin
  select cq.challenge_id,
    coalesce(
      cq.correct_answer,  -- real authored answer, denormalized at creation time
      case cq.item_type
        when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
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

  new_coins := finalize_challenge_if_done(v_challenge_id);
  select c.status = 'completed' into challenge_completed from challenges c where c.id = v_challenge_id;
  challenge_completed := coalesce(challenge_completed, false);

  return next;
end;
$function$;
