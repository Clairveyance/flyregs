-- Fold Rating (Instrument/Airframe/Powerplant) into Knowledge Level as one
-- shared filter axis, 2026-08-13. RC, Study Mode screenshot: "in Rating,
-- selecting ALL will allow questions covering all those other topics...
-- for students, PVT, etc that isn't helpful... can't we just fold those 3
-- items into the Knowledge area? that's really what we're testing anyway.
-- and b/c users can select/deselect multiple areas, they can then tailor
-- the Q bank to exactly their needs... this is needed, b/c otherwise,
-- there's no way to 'turn off' those 3 elements from the filter system."
--
-- Root cause: Knowledge Level used a strict intersection (item's own
-- levels must overlap the selection) but Rating used a PERMISSIVE filter
-- (`p_ratings IS NULL OR xxx_ratings(...) IS NULL OR xxx_ratings(...) &&
-- p_ratings` -- an item with NO rating tag always passed regardless of
-- what was selected). "ALL" for Rating meant zero restriction, and there
-- was no way to express "Student level, and specifically exclude
-- Instrument-only material" -- unchecking every Rating chip still left
-- rating-tagged content in the pool.
--
-- Fix: 4 new xxx_all_levels() wrappers union each type's existing
-- knowledge-level tags with its existing rating tags into ONE array,
-- filtered everywhere with Knowledge Level's own strict-intersection rule.
-- A section tagged only 'instrument' (no cert-level tag at all) now only
-- surfaces when 'instrument' itself is selected; general content keeps
-- showing under its own existing cert-level selection same as before,
-- since its array still contains those values regardless of which rating
-- chips are on. far_ratings()/aim_ratings()/ac_ratings()/pcg_ratings()
-- themselves are UNCHANGED -- this only changes how their output is
-- combined and filtered, not what counts as rating-specific content.
--
-- p_ratings is dropped from get_study_queue/get_study_pool_count/
-- create_challenge's signatures entirely (old 5-param overloads DROPped
-- first, not just replaced, to avoid leaving a stale duplicate overload --
-- see gotcha_create_or_replace_signature_overload.md). Client now folds
-- rating selections into the SAME p_levels array it already sends.

create or replace function public.far_all_levels(p_part text, p_subpart_letter text, p_section_number text)
returns text[] language sql immutable as $$
  select far_knowledge_levels(p_part, p_subpart_letter) || coalesce(far_ratings(p_part, p_section_number), '{}'::text[]);
$$;

create or replace function public.aim_all_levels(p_chapter text, p_paragraph_number text)
returns text[] language sql immutable as $$
  select aim_knowledge_levels(p_chapter, p_paragraph_number) || coalesce(aim_ratings(p_chapter, p_paragraph_number), '{}'::text[]);
$$;

create or replace function public.ac_all_levels(p_subject_series text)
returns text[] language sql immutable as $$
  select ac_knowledge_levels(p_subject_series) || coalesce(ac_ratings(p_subject_series), '{}'::text[]);
$$;

create or replace function public.pcg_all_levels(p_slug text, p_term text)
returns text[] language sql stable as $$
  select pcg_knowledge_levels(p_slug) || coalesce(pcg_ratings(p_term), '{}'::text[]);
$$;

drop function if exists public.get_study_pool_count(text[], text[], text[], text[]);
create or replace function public.get_study_pool_count(p_item_types text[] default null, p_levels text[] default null, p_category_classes text[] default null)
 returns integer
 language sql
 stable security definer
as $function$
  SELECT CASE WHEN NOT public.has_pro_access() THEN 0 ELSE
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND (p_levels IS NULL OR pcg_all_levels(p.slug, p.term) && p_levels)
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND f.section_number IN (SELECT section_number FROM study_far_sections)
         AND NOT (far_knowledge_levels(f.part, f.subpart_letter) && ARRAY['not_applicable'])
         AND (p_levels IS NULL OR far_all_levels(f.part, f.subpart_letter, f.section_number) && p_levels)
         AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND (p_levels IS NULL OR aim_all_levels(a.chapter, a.paragraph_number) && p_levels)
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
         AND (p_levels IS NULL OR ac_all_levels(c.subject_series) && p_levels)
         AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes))
  END;
$function$;

drop function if exists public.get_study_queue(integer, text[], text[], text[], text[]);
create or replace function public.get_study_queue(p_limit integer default 20, p_item_types text[] default null, p_levels text[] default null, p_category_classes text[] default null)
 returns table(item_id text, item_type text, term text, definition text, is_new boolean)
 language sql
 stable security definer
as $function$
  WITH due AS (
    SELECT sp.item_id, sp.item_type,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.term FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT '§ ' || f.section_number || ' ' || regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.paragraph_number || COALESCE(' ' || a.title, '') FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT 'AC ' || c.document_number || ': ' || c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
      END AS term,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.definition FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT f.body_text FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.body_text FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
      END AS definition,
      false AS is_new, extract(epoch FROM sp.next_review_at) AS sort_key
    FROM study_progress sp
    WHERE sp.user_id = auth.uid() AND sp.next_review_at <= now()
      AND (p_item_types IS NULL OR sp.item_type = ANY(p_item_types))
      AND (
        p_levels IS NULL
        OR (sp.item_type = 'aim' AND EXISTS (SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id AND aim_all_levels(a4.chapter, a4.paragraph_number) && p_levels))
        OR (sp.item_type = 'pcg' AND EXISTS (SELECT 1 FROM pcg_terms p4 WHERE p4.slug = sp.item_id AND pcg_all_levels(p4.slug, p4.term) && p_levels))
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3 WHERE f3.section_number = sp.item_id
                AND far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3 WHERE c3.document_number = sp.item_id
                AND ac_all_levels(c3.subject_series) && p_levels
            ))
      )
      AND (
        NOT (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3b WHERE f3b.section_number = sp.item_id
                AND far_knowledge_levels(f3b.part, f3b.subpart_letter) && ARRAY['not_applicable']
            ))
        AND NOT (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3b WHERE c3b.document_number = sp.item_id
                AND ac_knowledge_levels(c3b.subject_series) && ARRAY['not_applicable']
            ))
      )
      AND (
        p_category_classes IS NULL
        OR (sp.item_type = 'pcg' AND EXISTS (
              SELECT 1 FROM pcg_terms p3 WHERE p3.slug = sp.item_id
                AND (category_classes_from_text(p3.term) IS NULL OR category_classes_from_text(p3.term) && p_category_classes)
            ))
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f4 WHERE f4.section_number = sp.item_id
                AND (far_category_classes(f4.part, f4.title) IS NULL OR far_category_classes(f4.part, f4.title) && p_category_classes)
            ))
        OR (sp.item_type = 'aim' AND EXISTS (
              SELECT 1 FROM aim_paragraphs a4b WHERE a4b.paragraph_number = sp.item_id
                AND (aim_category_classes(a4b.chapter, COALESCE(a4b.title, '')) IS NULL OR aim_category_classes(a4b.chapter, COALESCE(a4b.title, '')) && p_category_classes)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c4 WHERE c4.document_number = sp.item_id
                AND (ac_category_classes(c4.subject_series, c4.title) IS NULL OR ac_category_classes(c4.subject_series, c4.title) && p_category_classes)
            ))
      )
  ),
  fresh_pcg AS (
    SELECT p.slug AS item_id, 'pcg' AS item_type, p.term, p.definition, true AS is_new
    FROM pcg_terms p
    WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
      AND (p_levels IS NULL OR pcg_all_levels(p.slug, p.term) && p_levels)
      AND p.definition IS NOT NULL AND p.definition <> ''
      AND p.slug NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'pcg')
      AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes)
    ORDER BY p.frequently_used DESC, random()
    LIMIT p_limit
  ),
  fresh_far AS (
    SELECT f.section_number AS item_id, 'far' AS item_type,
      '§ ' || f.section_number || ' ' || regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') AS term,
      f.body_text AS definition, true AS is_new
    FROM far_sections f
    WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
      AND f.body_text IS NOT NULL AND f.body_text <> ''
      AND f.title IS NOT NULL AND f.title <> ''
      AND f.section_number IN (SELECT section_number FROM study_far_sections)
      AND f.section_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'far')
      AND NOT (far_knowledge_levels(f.part, f.subpart_letter) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR far_all_levels(f.part, f.subpart_letter, f.section_number) && p_levels)
      AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
    ORDER BY (far_relevance_weight(f.part) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh_aim AS (
    SELECT a.paragraph_number AS item_id, 'aim' AS item_type,
      a.paragraph_number || COALESCE(' ' || a.title, '') AS term,
      a.body_text AS definition, true AS is_new
    FROM aim_paragraphs a
    WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
      AND (p_levels IS NULL OR aim_all_levels(a.chapter, a.paragraph_number) && p_levels)
      AND a.body_text IS NOT NULL AND a.body_text <> ''
      AND a.paragraph_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'aim')
      AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes)
    ORDER BY random()
    LIMIT p_limit
  ),
  fresh_ac AS (
    SELECT c.document_number AS item_id, 'ac' AS item_type,
      'AC ' || c.document_number || ': ' || c.title AS term,
      c.title AS definition, true AS is_new
    FROM advisory_circulars c
    WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
      AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
      AND c.title IS NOT NULL AND c.title <> ''
      AND c.document_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'ac')
      AND NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR ac_all_levels(c.subject_series) && p_levels)
      AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
    ORDER BY (ac_relevance_weight(c.document_number) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh AS (
    SELECT * FROM fresh_pcg
    UNION ALL SELECT * FROM fresh_far
    UNION ALL SELECT * FROM fresh_aim
    UNION ALL SELECT * FROM fresh_ac
  ),
  combined AS (
    SELECT item_id, item_type, term, definition, is_new, 0 AS prio, sort_key FROM due
    WHERE term IS NOT NULL AND btrim(term) <> '' AND definition IS NOT NULL AND btrim(definition) <> ''
    UNION ALL
    SELECT item_id, item_type, term, definition, is_new, 1 AS prio, random() AS sort_key FROM fresh
  )
  SELECT item_id, item_type, term, definition, is_new FROM combined
  WHERE public.has_pro_access()
  ORDER BY prio, sort_key
  LIMIT p_limit;
$function$;

drop function if exists public.create_challenge(uuid[], integer, text[], text[], text[], text[]);
create or replace function public.create_challenge(p_opponent_ids uuid[], p_question_count integer default 5, p_item_types text[] default null, p_levels text[] default null, p_category_classes text[] default null)
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

  -- `ratings` column intentionally left null -- rating selections now live
  -- in `levels` alongside cert-level values (see this migration's header).
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
          and (p_levels is null or ac_all_levels(c2.subject_series) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
        order by (ac_relevance_weight(c2.document_number) + 1) * random() desc limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
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

    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_all_levels(slug, term) && p_levels) and term <> v_item.item_id order by random() limit 5) t;
      when 'far' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels)
              and f3.section_number <> v_item.item_id order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and not (ac_knowledge_levels(c3.subject_series) && array['not_applicable'])
              and (p_levels is null or ac_all_levels(c3.subject_series) && p_levels)
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
