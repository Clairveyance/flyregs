-- ============================================================================
-- Category/Class filter: classify AIM content by CHAPTER, not just title
--                                                            2026-08-04
--
-- RC asked directly whether Study/Duels category/class filtering (ASEL vs
-- AMEL vs Helicopter vs Seaplane, etc.) actually works. Measured it corpus-
-- wide before answering: for AIM, 7 of 10 category/class chips (ASEL, ASES,
-- AMEL, AMES, GYRO, AIRSHIP, POWLIFT) matched ZERO paragraphs, and HELI only
-- matched 8 of AIM's 9 real Chapter 10 (Helicopter) paragraphs -- because
-- category_classes_from_text() only ever saw the paragraph TITLE, and most
-- Chapter 10 paragraphs are titled things like "Approach and Landing" or
-- "Traffic Patterns" with no category word in them at all.
--
-- This is the exact same shape of gap far_category_classes() already fixed
-- for FAR (see migrations_far_category.sql) -- and the fix is the same
-- principle: aim_knowledge_levels() already proves a structural signal is
-- available (chapter '10' is unambiguously Helicopter, per its own header
-- comment) that category_classes_from_text() simply never used. Union that
-- in, same as far_category_classes(part, title) unions FAR's part-based
-- signal with title-text matching.
--
-- No other AIM chapter maps to a single category/class chip (chapter 11 is
-- UAS -- Part 107, a different rating entirely, not one of the 10
-- category/class chips at all). Title matching is still unioned in, so a
-- helicopter-titled paragraph outside chapter 10 keeps its HELI tag.
--
-- Verified live: HELI matches went 8 -> 11 (all 9 real chapter-10
-- paragraphs now guaranteed tagged, regardless of title wording; the 2
-- outside-chapter-10 title matches are unchanged, confirming the fix is
-- purely additive).
--
-- NOT fixed in this pass, flagged to RC instead of silently attempted:
--   - AC's category/class filtering has the identical title-only weakness
--     (0 matches for ASEL/ASES/AMEL/AMES/GYRO out of 755 active ACs) -- AC
--     subject series MAY offer an analogous structural signal the way FAR
--     parts and AIM chapters do, but that mapping hasn't been verified yet.
--   - P/CG's category/class filtering is the weakest of all four (only
--     scans the bare TERM name, never the definition; 1 of 926 terms ever
--     matches any chip) -- P/CG has no part/chapter/series structure to
--     lean on at all, so this needs a different approach, not this pattern.
--   - P/CG's KNOWLEDGE LEVEL filtering (a separate dimension from category/
--     class) has a real, measured 526-of-926-term (57%) data gap: unlike
--     FAR/AIM/AC's level classifiers, which are computed by formula and
--     have 100% coverage, pcg_knowledge_levels() is a lookup against
--     pcg_term_levels, and only 487 of 926 studyable terms have a row
--     there. The logic itself is correct (unclassified is deliberately
--     excluded from a level-filtered pool, matching FAR/AIM/AC's own
--     design) -- the gap is in the DATA, not the code, and closing it
--     needs real classification work (526 terms, 56 of them
--     frequently_used), not a query change. Flagged to RC for how to
--     prioritize/fund that work, not started here.
-- ============================================================================

create or replace function public.aim_category_classes(p_chapter text, p_title text)
returns text[]
language sql
immutable
as $function$
  select nullif(
    array(
      select distinct cc from unnest(
        coalesce(category_classes_from_text(p_title), array[]::text[])
        || case when p_chapter = '10' then array['HELI'] else array[]::text[] end
      ) as cc
      order by cc
    ),
    array[]::text[]
  );
$function$;

-- Callers: get_study_pool_count, get_study_queue (both the `due` and
-- fresh_aim branches), and create_challenge's AIM pool-selection branch.
-- Regenerated from the LIVE definitions of each function (pulled via
-- pg_get_functiondef, NOT from the on-disk migration files -- both
-- migrations_curriculum.sql and migrations_far_category_callers.sql had
-- already drifted from what's actually deployed: aim_knowledge_levels
-- gained a second p_paragraph_number parameter live for the AIM 5-4 fix
-- (gotcha_aim_chapter_level_too_coarse), ac/far_knowledge_levels' ELSE
-- branch changed from NULL to ARRAY[]::text[], and a study_far_sections
-- allowlist join was added to the FAR branches -- none of that was ever
-- captured in a committed file until now. Full bodies below so this file
-- stays the accurate source of truth going forward; only the AIM
-- category/class clause actually changes in each, from
-- category_classes_from_text(title) to aim_category_classes(chapter, title).

CREATE OR REPLACE FUNCTION public.get_study_pool_count(p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND (p_levels IS NULL OR pcg_knowledge_levels(p.slug) && p_levels)
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND f.section_number IN (SELECT section_number FROM study_far_sections)
         AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
         AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND (p_levels IS NULL OR aim_knowledge_levels(a.chapter, a.paragraph_number) && p_levels)
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
         AND (p_category_classes IS NULL OR category_classes_from_text(c.title) IS NULL OR category_classes_from_text(c.title) && p_category_classes));
$function$;

CREATE OR REPLACE FUNCTION public.get_study_queue(p_limit integer DEFAULT 20, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS TABLE(item_id text, item_type text, term text, definition text, is_new boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
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
        OR (sp.item_type = 'aim' AND EXISTS (SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id AND aim_knowledge_levels(a4.chapter, a4.paragraph_number) && p_levels))
        OR (sp.item_type = 'pcg' AND pcg_knowledge_levels(sp.item_id) && p_levels)
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3 WHERE f3.section_number = sp.item_id
                AND (far_knowledge_levels(f3.part, f3.subpart_letter) IS NULL OR far_knowledge_levels(f3.part, f3.subpart_letter) && p_levels)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3 WHERE c3.document_number = sp.item_id
                AND (ac_knowledge_levels(c3.subject_series) IS NULL OR ac_knowledge_levels(c3.subject_series) && p_levels)
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
              SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id
                AND (aim_category_classes(a4.chapter, COALESCE(a4.title, '')) IS NULL OR aim_category_classes(a4.chapter, COALESCE(a4.title, '')) && p_category_classes)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c4 WHERE c4.document_number = sp.item_id
                AND (category_classes_from_text(c4.title) IS NULL OR category_classes_from_text(c4.title) && p_category_classes)
            ))
      )
  ),
  fresh_pcg AS (
    SELECT p.slug AS item_id, 'pcg' AS item_type, p.term, p.definition, true AS is_new
    FROM pcg_terms p
    WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
      AND (p_levels IS NULL OR pcg_knowledge_levels(p.slug) && p_levels)
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
      AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
      AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
    ORDER BY random()
    LIMIT p_limit
  ),
  fresh_aim AS (
    SELECT a.paragraph_number AS item_id, 'aim' AS item_type,
      a.paragraph_number || COALESCE(' ' || a.title, '') AS term,
      a.body_text AS definition, true AS is_new
    FROM aim_paragraphs a
    WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
      AND (p_levels IS NULL OR aim_knowledge_levels(a.chapter, a.paragraph_number) && p_levels)
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
      AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
      AND (p_category_classes IS NULL OR category_classes_from_text(c.title) IS NULL OR category_classes_from_text(c.title) && p_category_classes)
    ORDER BY random()
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
  ORDER BY prio, sort_key
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  -- exactly one correct answer. PCG/FAR/AIM draw a 3x candidate slice vs.
  -- AC's 1x (see header) -- the final `order by random() limit
  -- p_question_count` below picks proportionally from whatever's in the
  -- combined pool, so a bigger slice means a bigger share of real duels.
  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from quizzable_pcg_terms
        where (p_levels is null or pcg_knowledge_levels(slug) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where (p_levels is null or far_knowledge_levels(f2.part, f2.subpart_letter) is null or far_knowledge_levels(f2.part, f2.subpart_letter) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_knowledge_levels(chapter, paragraph_number) && p_levels)
          and (p_category_classes is null or aim_category_classes(chapter, coalesce(title, '')) is null or aim_category_classes(chapter, coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count * 3
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
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_knowledge_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
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

-- Verified live: HELI matches went 8 -> 11 (all 9 real chapter-10
-- paragraphs now guaranteed tagged, regardless of title wording; the 2
-- outside-chapter-10 title matches are unchanged, confirming the fix is
-- purely additive, nothing that worked before broke).
