-- Study/Duel architecture completion, part 2 -- 2026-08-28
--
-- RC: "make sure all of our study materials, across all regs and corpus
-- are fully viable." Measured after the FAR/CFR49 fix: the SAME
-- prompt_uses=1 collision guard exists on quizzable_pcg_terms,
-- quizzable_aim_paragraphs, quizzable_advisory_circulars, and
-- quizzable_dictionary_terms -- and it's hiding a real, non-trivial
-- fraction of each from Duels specifically (Study Mode never used these
-- views for pcg/aim/dictionary, and already got the AC fix earlier):
--   PCG: 846 of 1,012 eligible (166 hidden, 16%)
--   AIM: 407 of 438 eligible (31 hidden, 7%)
--   AC: 756 of 758 eligible (2 hidden, negligible -- already close to complete)
--   Dictionary: 5,301 of 6,387 eligible (1,086 hidden, 17%)
-- Same fix as far/cfr49 (part 1 of this migration pair): drop prompt_uses
-- = 1, keep the genuinely unrelated data-quality guards each view
-- already had (e.g. pcg/dictionary's "the term doesn't just appear
-- inside its own definition" check -- a different, legitimate concern:
-- a reference-recall question whose answer is spelled out in the
-- question text is a giveaway, not an ambiguity problem).
--
-- Also adds the same same-prompt-distractor exclusion to
-- create_challenge's pcg/aim/ac/dictionary fallback branches that far/
-- cfr49 already got, for the identical reason: a graceful multiple-
-- choice fallback can still coincidentally draw a distractor sharing
-- the selected item's own quiz prompt.

-- ============================================================
-- Widened views
-- ============================================================
create or replace view public.quizzable_pcg_terms as
select id, term, slug, letter, definition, frequently_used, see_refs, external_refs, updated_at, search_vector, quiz_prompt, prompt_uses
from (
  select p0.id, p0.term, p0.slug, p0.letter, p0.definition, p0.frequently_used, p0.see_refs, p0.external_refs, p0.updated_at, p0.search_vector,
    p0.definition as quiz_prompt,
    count(*) over (partition by p0.definition) as prompt_uses
  from pcg_terms p0
  where p0.definition is not null and p0.definition <> '' and p0.term is not null
) p
where position(lower(term) in lower(definition)) = 0;

create or replace view public.quizzable_aim_paragraphs as
select id, paragraph_number, chapter, section_title, title, body_text, reference_text, updated_at, search_vector, quiz_prompt, prompt_uses
from (
  select a0.id, a0.paragraph_number, a0.chapter, a0.section_title, a0.title, a0.body_text, a0.reference_text, a0.updated_at, a0.search_vector,
    a0.title as quiz_prompt,
    count(*) over (partition by a0.title) as prompt_uses
  from aim_paragraphs a0
  where a0.title is not null and a0.title <> ''
) a
where position(lower(paragraph_number) in lower(title)) = 0;

create or replace view public.quizzable_advisory_circulars as
select id, document_number, title, date_issued, office, change_number, status, subject_series, description, document_id, cancels,
  pdf_url_faa, pdf_url_cached, pdf_size_bytes, pdf_text, last_scraped_at, created_at, updated_at, pdf_blocks, pdf_blocks_version,
  search_vector, changed_block_indices, quiz_prompt, prompt_uses
from (
  select c0.id, c0.document_number, c0.title, c0.date_issued, c0.office, c0.change_number, c0.status, c0.subject_series, c0.description,
    c0.document_id, c0.cancels, c0.pdf_url_faa, c0.pdf_url_cached, c0.pdf_size_bytes, c0.pdf_text, c0.last_scraped_at, c0.created_at,
    c0.updated_at, c0.pdf_blocks, c0.pdf_blocks_version, c0.search_vector, c0.changed_block_indices,
    c0.title as quiz_prompt,
    count(*) over (partition by c0.title) as prompt_uses
  from advisory_circulars c0
  where c0.status = 'active' and c0.title is not null and c0.title <> '' and c0.description is not null and c0.description <> ''
) c
where position(lower(document_number) in lower(title)) = 0;

create or replace view public.quizzable_dictionary_terms as
select id, term, slug, category, mnemonic_group, quiz_prompt, prompt_uses
from (
  select d.id, d.term, d.slug, d.category, d.mnemonic_group,
    (d.senses->0->>'definition') as quiz_prompt,
    count(*) over (partition by (d.senses->0->>'definition')) as prompt_uses
  from dictionary_terms d
  where d.category = any(array['handbook','mnemonic']) and (d.senses->0->>'definition') is not null and (d.senses->0->>'definition') <> '' and d.term is not null
) p
where position(lower(term) in lower(quiz_prompt)) = 0;

-- ============================================================
-- create_challenge -- add same-prompt-distractor exclusion to pcg/aim/
-- ac/dictionary fallback branches (far/cfr49 already got this in part 1).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_fact record;
  v_have_fact boolean;
  v_i int := 0;
  v_choices text[];
  v_opp uuid;
  v_used_fact_ids uuid[] := array[]::uuid[];
  v_unavailable_callsigns text;
  v_non_premium_callsigns text;
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

  select string_agg(coalesce(cr.callsign, 'That pilot'), ', ')
  into v_unavailable_callsigns
  from unnest(p_opponent_ids) opp_id
  left join callsign_registry cr on cr.user_id = opp_id
  where not exists (
    select 1 from user_streaks us where us.user_id = opp_id and us.leaderboard_opt_in = true
  );
  if v_unavailable_callsigns is not null then
    raise exception '% hasn''t enabled Duel challenges yet. Remove them to continue.', v_unavailable_callsigns;
  end if;

  select string_agg(coalesce(cr.callsign, 'That pilot'), ', ')
  into v_non_premium_callsigns
  from unnest(p_opponent_ids) opp_id
  left join callsign_registry cr on cr.user_id = opp_id
  where not exists (
    select 1 from user_entitlements ue3 where ue3.user_id = opp_id and ue3.is_premium = true
  );
  if v_non_premium_callsigns is not null then
    raise exception '% isn''t on Premium, so they can''t be added to a Duel. Remove them to continue.', v_non_premium_callsigns;
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
        from quizzable_pcg_terms
        where (p_levels is null or pcg_all_levels(slug, term) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where not (far_knowledge_levels(f2.part, f2.subpart_letter) && array['not_applicable'])
          and (p_levels is null or far_all_levels(f2.part, f2.subpart_letter, f2.section_number) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
        order by (far_relevance_weight(f2.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels)
          and (p_category_classes is null or aim_category_classes(chapter, coalesce(title, '')) is null or aim_category_classes(chapter, coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from quizzable_advisory_circulars c2
        where not (ac_knowledge_levels(c2.subject_series) && array['not_applicable'])
          and (p_levels is null or ac_all_levels(c2.subject_series, c2.document_number) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
        order by (ac_relevance_weight(c2.document_number) + 1) * random() desc limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'dictionary' as item_type, slug as item_id
        from quizzable_dictionary_terms
        where (p_levels is null or dictionary_all_levels(slug) && p_levels)
          and (p_category_classes is null or dictionary_category_classes(slug) is null or dictionary_category_classes(slug) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'dictionary' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'cfr49' as item_type, section_number as item_id
        from quizzable_cfr49_sections f7
        where not (cfr49_knowledge_levels(f7.part) && array['not_applicable'])
          and (p_levels is null or cfr49_all_levels(f7.part, f7.section_number) && p_levels)
          and (p_category_classes is null or cfr49_category_classes(f7.part, f7.title) is null or cfr49_category_classes(f7.part, f7.title) && p_category_classes)
        order by (cfr49_relevance_weight(f7.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'cfr49' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    v_have_fact := false;
    if v_item.item_type in ('far', 'aim', 'ac', 'dictionary', 'cfr49') then
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

    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_all_levels(slug, term) && p_levels) and term <> v_item.item_id
              and definition <> (select p3z.definition from pcg_terms p3z where p3z.term = v_item.item_id)
              order by random() limit 5) t;
      when 'far' then
        -- Same-title-distractor exclusion: a random distractor that
        -- happens to share the selected section's own (cleaned) title
        -- would make the quiz_prompt genuinely ambiguous (two visibly
        -- "correct-looking" choices) -- see this file's header comment.
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels)
              and f3.section_number <> v_item.item_id
              and regexp_replace(f3.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') <> (
                    select regexp_replace(f3z.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
                    from far_sections f3z where f3z.section_number = v_item.item_id
                  )
              order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id
              and title <> (select a3z.title from aim_paragraphs a3z where a3z.paragraph_number = v_item.item_id)
              order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and not (ac_knowledge_levels(c3.subject_series) && array['not_applicable'])
              and (p_levels is null or ac_all_levels(c3.subject_series, c3.document_number) && p_levels)
              and c3.document_number <> v_item.item_id
              and c3.title <> (select c3z.title from advisory_circulars c3z where c3z.document_number = v_item.item_id)
              order by random() limit 5) t;
      when 'dictionary' then
        select array_cat(
          array[(select d.term from dictionary_terms d where d.slug = v_item.item_id)],
          coalesce(array_agg(t.term), array[]::text[])
        )
        into v_choices
        from (select term, quiz_prompt from quizzable_dictionary_terms
              where (p_levels is null or dictionary_all_levels(slug) && p_levels)
              and slug <> v_item.item_id
              and quiz_prompt <> (select d3z.quiz_prompt from quizzable_dictionary_terms d3z where d3z.slug = v_item.item_id)
              order by random() limit 5) t;
      when 'cfr49' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from cfr49_sections f8 where f8.title is not null and f8.title <> ''
              and not (cfr49_knowledge_levels(f8.part) && array['not_applicable'])
              and (p_levels is null or cfr49_all_levels(f8.part, f8.section_number) && p_levels)
              and f8.section_number <> v_item.item_id
              and regexp_replace(f8.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') <> (
                    select regexp_replace(f8z.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
                    from cfr49_sections f8z where f8z.section_number = v_item.item_id
                  )
              order by random() limit 5) t;
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
;

grant execute on function public.create_challenge(uuid[], integer, text[], text[], text[]) to authenticated;
