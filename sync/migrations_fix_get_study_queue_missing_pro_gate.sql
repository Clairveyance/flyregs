-- Real production bug found 2026-08-12 during the post-create_challenge-fix
-- full gating/security re-sweep, while spot-checking that the 440 Opus-
-- repaired study_facts rows are gated the same as any other row.
--
-- get_study_pool_count() (the count RPC) has a real has_pro_access() gate
-- (returns 0 for non-Pro). get_study_queue() -- the RPC that actually
-- returns real card CONTENT (far/aim body_text, pcg definitions, ac
-- titles) -- had NO tier check at all in its live definition, despite a
-- comment elsewhere in the codebase (scripts/filter_matrix_test.py,
-- scenario_study()) claiming "Study Mode is Pro-gated as of the
-- 2026-08-11 gating sweep (both RPCs used to have zero tier check at all)"
-- -- that comment was simply wrong about get_study_queue specifically, or
-- a later CREATE OR REPLACE dropped the gate without anyone noticing
-- (classic migration-files-drift-from-live shape, this codebase's own
-- recurring gotcha).
--
-- Live-verified before this fix: a genuinely fresh, disposable, Free-tier
-- account (zero user_entitlements row) calling get_study_queue directly
-- via RPC got 200 real rows back, including verbatim FAR body_text (e.g.
-- full text of 91.858, 91.611, 91.413). This is a real, currently-active
-- Pro-paywall bypass for Study Mode's actual content -- not merely a
-- client-side gap, since it's exploitable via a direct RPC/curl call
-- regardless of what the app's UI does.
--
-- Fix: same has_pro_access() gate get_study_pool_count() already uses,
-- applied as a WHERE clause on the final SELECT -- non-Pro callers get
-- zero rows (matching pool_count's "return 0" behavior for the same
-- case), Pro/Premium callers see zero behavior change.

create or replace function public.get_study_queue(
  p_limit integer default 20,
  p_item_types text[] default null::text[],
  p_levels text[] default null::text[],
  p_category_classes text[] default null::text[],
  p_ratings text[] default null::text[]
)
returns table(item_id text, item_type text, term text, definition text, is_new boolean)
language sql
stable
security definer
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
        OR (sp.item_type = 'aim' AND EXISTS (SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id AND aim_knowledge_levels(a4.chapter, a4.paragraph_number) && p_levels))
        OR (sp.item_type = 'pcg' AND pcg_knowledge_levels(sp.item_id) && p_levels)
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3 WHERE f3.section_number = sp.item_id
                AND far_knowledge_levels(f3.part, f3.subpart_letter) && p_levels
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3 WHERE c3.document_number = sp.item_id
                AND ac_knowledge_levels(c3.subject_series) && p_levels
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
              SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id
                AND (aim_category_classes(a4.chapter, COALESCE(a4.title, '')) IS NULL OR aim_category_classes(a4.chapter, COALESCE(a4.title, '')) && p_category_classes)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c4 WHERE c4.document_number = sp.item_id
                AND (ac_category_classes(c4.subject_series, c4.title) IS NULL OR ac_category_classes(c4.subject_series, c4.title) && p_category_classes)
            ))
      )
      AND (
        p_ratings IS NULL
        OR (sp.item_type = 'pcg' AND EXISTS (
              SELECT 1 FROM pcg_terms p5 WHERE p5.slug = sp.item_id
                AND (pcg_ratings(p5.term) IS NULL OR pcg_ratings(p5.term) && p_ratings)
            ))
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f5 WHERE f5.section_number = sp.item_id
                AND (far_ratings(f5.part, f5.section_number) IS NULL OR far_ratings(f5.part, f5.section_number) && p_ratings)
            ))
        OR (sp.item_type = 'aim' AND EXISTS (
              SELECT 1 FROM aim_paragraphs a5 WHERE a5.paragraph_number = sp.item_id
                AND (aim_ratings(a5.chapter, a5.paragraph_number) IS NULL OR aim_ratings(a5.chapter, a5.paragraph_number) && p_ratings)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c5 WHERE c5.document_number = sp.item_id
                AND (ac_ratings(c5.subject_series) IS NULL OR ac_ratings(c5.subject_series) && p_ratings)
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
      AND (p_ratings IS NULL OR pcg_ratings(p.term) IS NULL OR pcg_ratings(p.term) && p_ratings)
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
      AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
      AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
      AND (p_ratings IS NULL OR far_ratings(f.part, f.section_number) IS NULL OR far_ratings(f.part, f.section_number) && p_ratings)
    ORDER BY (far_relevance_weight(f.part) + 1) * random() DESC
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
      AND (p_ratings IS NULL OR aim_ratings(a.chapter, a.paragraph_number) IS NULL OR aim_ratings(a.chapter, a.paragraph_number) && p_ratings)
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
      AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
      AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
      AND (p_ratings IS NULL OR ac_ratings(c.subject_series) IS NULL OR ac_ratings(c.subject_series) && p_ratings)
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
