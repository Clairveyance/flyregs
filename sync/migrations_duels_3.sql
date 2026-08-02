-- ============================================================================
-- Duels/Study question-pool integrity  --  2026-07-31
--
-- D7  Questions with more than one correct answer. A Duel shows a title (or
--     a P/CG definition) and asks you to pick the document number it belongs
--     to -- so the prompt has to identify exactly ONE item. It didn't:
--
--       FAR   1,940 of 4,272 sections (45%) share their displayed title with
--             at least one other section. Worst offenders: "Applicability."
--             x181, "General." x81, "[Reserved]" x65, "Definitions." x47,
--             "Scope." x21. "WHICH FAR SECTION IS THIS? -- Applicability."
--             has 181 correct answers and grades 180 of them wrong.
--       AIM   31 paragraphs across 9 titles, led by "General" x15. Caught
--             live in the app: a duel served "Figures" (4-2-8).
--       P/CG  6 terms across 3 identical definitions.
--       AC    0 -- already clean.
--
--     "[Reserved]" is worse than ambiguous: those sections have no content
--     at all, so the question is meaningless even before the tie.
--
--     Fix: quizzable_* views expose only items whose prompt is unique inside
--     its own corpus, and create_challenge draws its questions from them.
--     Remaining pools are healthy -- FAR 2,332 / AIM 407 / P/CG 920 / AC 778.
--
--     Plain views, not materialized: they stay correct the moment a scraper
--     inserts a row, so there's nothing to wire into sync_ad.sh and no way
--     for the pool to drift out of date behind the content.
--
--     Distractors deliberately do NOT require uniqueness -- a decoy sharing
--     some OTHER item's title creates no ambiguity once the keyed answer is
--     unique, and the wider decoy pool keeps variety up.
-- ============================================================================

create or replace view public.quizzable_far_sections as
select f.*, regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt
from far_sections f
where f.title is not null and f.title <> ''
  and regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') in (
    select regexp_replace(title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
    from far_sections
    where title is not null and title <> ''
    group by 1 having count(*) = 1
  );

create or replace view public.quizzable_aim_paragraphs as
select a.*, a.title as quiz_prompt
from aim_paragraphs a
where a.title is not null and a.title <> ''
  and a.title in (
    select title from aim_paragraphs
    where title is not null and title <> ''
    group by 1 having count(*) = 1
  );

create or replace view public.quizzable_pcg_terms as
select p.*, p.definition as quiz_prompt
from pcg_terms p
where p.definition is not null and p.definition <> '' and p.term is not null
  and p.definition in (
    select definition from pcg_terms
    where definition is not null and definition <> '' and term is not null
    group by 1 having count(*) = 1
  );

create or replace view public.quizzable_advisory_circulars as
select c.*, c.title as quiz_prompt
from advisory_circulars c
where c.status = 'active'
  and c.title is not null and c.title <> ''
  and c.description is not null and c.description <> ''
  and c.title in (
    select title from advisory_circulars
    where status = 'active' and title is not null and title <> ''
      and description is not null and description <> ''
    group by 1 having count(*) = 1
  );

grant select on public.quizzable_far_sections to anon, authenticated;
grant select on public.quizzable_aim_paragraphs to anon, authenticated;
grant select on public.quizzable_pcg_terms to anon, authenticated;
grant select on public.quizzable_advisory_circulars to anon, authenticated;

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

  -- D7: every branch draws from quizzable_*, so the prompt always has
  -- exactly one correct answer.
  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from quizzable_pcg_terms
        where (p_levels is null or pcg_knowledge_levels(slug) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where (p_levels is null or far_knowledge_levels(f2.part, f2.subpart_letter) is null or far_knowledge_levels(f2.part, f2.subpart_letter) && p_levels)
          and (p_category_classes is null or category_classes_from_text(f2.title) is null or category_classes_from_text(f2.title) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_knowledge_levels(chapter) && p_levels)
          and (p_category_classes is null or category_classes_from_text(coalesce(title, '')) is null or category_classes_from_text(coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from quizzable_advisory_circulars c2
        where (p_levels is null or ac_knowledge_levels(c2.subject_series) is null or ac_knowledge_levels(c2.subject_series) && p_levels)
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
    -- on material the filter exists to exclude.
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

  if v_i = 0 then
    raise exception 'No questions match those filters. Try widening the Content or Knowledge Level selection.';
  end if;

  if v_i <> p_question_count then
    update challenges set question_count = v_i where id = v_challenge_id;
  end if;

  return v_challenge_id;
end;
$function$;
