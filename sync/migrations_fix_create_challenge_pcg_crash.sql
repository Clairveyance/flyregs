-- Real production bug found 2026-08-12 while re-verifying filter_matrix_test.py
-- after tonight's ingestion: create_challenge() 500s with "record 'v_fact' is
-- not assigned yet / tuple structure of a not-yet-assigned record is
-- indeterminate" whenever the loop processes a 'pcg' item.
--
-- Root cause: v_fact is a bare `record` variable. Its structure is only
-- established the first time a real `SELECT ... INTO v_fact` actually runs.
-- The per-iteration `v_fact := null;` reset does NOT establish a structure on
-- its own, and the study_facts lookup is deliberately skipped for item_type
-- 'pcg' (pcg is never authored into study_facts). So on ANY iteration whose
-- FIRST-in-loop-order item is 'pcg' -- guaranteed for a PCG-only duel, and
-- possible at random for any mixed-type duel -- `v_fact.id` on the very next
-- line is accessed on a record that has never had a structure at all, and
-- Postgres throws rather than treating it as null.
--
-- Confirmed via direct query that zero real duels have ever successfully
-- included 'pcg' in item_types -- this has likely been broken since PCG
-- became a Duel content-type option, not a regression from tonight's
-- study_facts/fact_id rewire (that rewire only added the v_fact machinery
-- for far/aim/ac; it never touched how pcg is handled).
--
-- Fix: replace the `v_fact.id is not null` structural check with an explicit
-- boolean flag (`v_have_fact`) set from FOUND right after the SELECT INTO,
-- so v_fact's fields are only ever touched once we know a real row was
-- assigned. No more null-assign attempted on an unstructured record.

create or replace function public.create_challenge(
  p_opponent_ids uuid[],
  p_question_count integer default 5,
  p_item_types text[] default null::text[],
  p_levels text[] default null::text[],
  p_category_classes text[] default null::text[],
  p_ratings text[] default null::text[]
)
returns uuid
language plpgsql
security definer
as $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_fact record;
  v_have_fact boolean;
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
    --
    -- v_have_fact (not `v_fact.id is not null`) is the control flag here on
    -- purpose -- see this migration's header comment. v_fact's fields are
    -- only ever touched below once v_have_fact is true, i.e. only right
    -- after a SELECT INTO that actually ran and found a row.
    v_have_fact := false;
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
      v_have_fact := found;
    end if;

    if v_have_fact then
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
$function$
