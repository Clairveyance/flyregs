-- get_study_queue: a repeat review must clear the same bar a new card does.
--
-- Two gaps, one invariant. fresh_far / fresh_ac / fresh_cfr49 each require a
-- 'live' study_facts row before dealing a card. fresh_aim did not, and the
-- `due` CTE (every REPEAT spaced-repetition card, all types) did not either.
--
--   * fresh_aim: 8 AIM paragraphs have body_text but no live fact. The server
--     deals them; study.tsx then drops every far/aim card with no fact. Those
--     cards silently shrink the deck -- ask for 20, get fewer -- on any
--     session that happens to draw one.
--
--   * due (far/aim only): the more serious half, and currently latent. Nothing is stuck
--     today (verified: 0 far/aim/ac/cfr49 progress rows without a live fact;
--     the only 3 factless rows are pcg, which is correctly ungated). But
--     5,053 study_facts rows are already 'flagged' and 9 'stale', so the
--     moment a user has reviewed one of those, its progress row can never be
--     dealt again, never advances next_review_at, and sorts to the front of
--     every subsequent deck forever.
--
-- Built additively from the LIVE pg_get_functiondef output -- migration files
-- drift from the live DB (gotcha_migration_files_drift_from_live_db); this is
-- that output with two WHERE clauses added and nothing else changed.

CREATE OR REPLACE FUNCTION public.get_study_queue(p_limit integer DEFAULT 20, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS TABLE(item_id text, item_type text, term text, definition text, is_new boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH due AS (
    SELECT sp.item_id, sp.item_type,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.term FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT '§ ' || f.section_number || ' ' || regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.paragraph_number || COALESCE(' ' || a.title, '') FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT 'AC ' || c.document_number || ': ' || c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
        WHEN 'dictionary' THEN (SELECT d.term FROM dictionary_terms d WHERE d.slug = sp.item_id)
        WHEN 'cfr49' THEN (SELECT '49 CFR ' || f5.section_number || ' ' || regexp_replace(f5.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') FROM cfr49_sections f5 WHERE f5.section_number = sp.item_id)
      END AS term,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.definition FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT f.body_text FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.body_text FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
        WHEN 'dictionary' THEN (SELECT d.senses->0->>'definition' FROM dictionary_terms d WHERE d.slug = sp.item_id)
        WHEN 'cfr49' THEN (SELECT f5.body_text FROM cfr49_sections f5 WHERE f5.section_number = sp.item_id)
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
                AND ac_all_levels(c3.subject_series, c3.document_number) && p_levels
            ))
        OR (sp.item_type = 'dictionary' AND dictionary_all_levels(sp.item_id) && p_levels)
        OR (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6 WHERE f6.section_number = sp.item_id
                AND cfr49_all_levels(f6.part, f6.section_number) && p_levels
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
        AND NOT (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6b WHERE f6b.section_number = sp.item_id
                AND cfr49_knowledge_levels(f6b.part) && ARRAY['not_applicable']
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
        OR (sp.item_type = 'dictionary' AND EXISTS (
              SELECT 1 FROM dictionary_terms d4 WHERE d4.slug = sp.item_id
                AND (dictionary_category_classes(d4.slug) IS NULL OR dictionary_category_classes(d4.slug) && p_category_classes)
            ))
        OR (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6c WHERE f6c.section_number = sp.item_id
                AND (cfr49_category_classes(f6c.part, f6c.title) IS NULL OR cfr49_category_classes(f6c.part, f6c.title) && p_category_classes)
            ))
      )
      -- A repeat review must clear the SAME bar a new card does. fresh_far,
      -- fresh_ac, fresh_cfr49 (and now fresh_aim) each require a 'live'
      -- study_facts row; `due` required nothing, so once a fact left 'live'
      -- its progress row became undealable-but-still-due: study.tsx drops
      -- far/aim cards with no fact, never calls record_study_review, so
      -- next_review_at never advances -- and `combined` orders due first by
      -- next_review_at ASC, which sorts the stuck rows to the FRONT of every
      -- future deck. Enough of them and every session returns a deck the
      -- client empties, showing "You've reviewed everything that's due"
      -- while poolCount reads thousands.
      --
      -- Gated for far/aim ONLY -- the exact two types study.tsx drops. Scope
      -- matters and I got it wrong first: my initial pass also gated 'ac' and
      -- 'cfr49' because fresh_ac/fresh_cfr49 require a live fact for NEW
      -- cards. But dealing a new card and continuing an existing one are
      -- different bars. The client renders ac and cfr49 fine WITHOUT a fact
      -- (buildStudyCard has a real cfr49 branch, and AC's title->number card
      -- is RC's own 2026-07-31 design), so gating them here made a perfectly
      -- reviewable card vanish. scripts/study_lifecycle_test.py caught it
      -- immediately: "due ac:61-65K resurfaces in the queue" FAILED, because
      -- all 7 of that AC's facts are 'flagged'. pcg/dictionary are ungated
      -- for the same reason.
      --
      -- Measured 2026-09-04: 0 far/aim progress rows currently lack a live
      -- fact, so nobody is stuck today -- but 5,053 facts are already
      -- 'flagged' and 9 'stale', so this is when-not-if, not hypothetical.
      AND (
        sp.item_type NOT IN ('far', 'aim')
        OR EXISTS (
             SELECT 1 FROM study_facts sfd
             WHERE sfd.item_type = sp.item_type
               AND sfd.item_id   = sp.item_id
               AND sfd.status    = 'live'
           )
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
      -- Same fix fresh_ac already had (see its own comment below): only
      -- surface a FAR section as "new" once it has a real authored fact --
      -- otherwise the client falls back to the bare "Which Part N rule
      -- covers X?" placeholder, which is ambiguous for any section whose
      -- title collides with a sibling's (now that study_far_sections no
      -- longer excludes those, this gate is what keeps the fallback safe).
      AND EXISTS (
            SELECT 1 FROM study_facts sf2
            WHERE sf2.item_type = 'far' AND sf2.item_id = f.section_number AND sf2.status = 'live'
          )
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
      AND a.body_text IS NOT NULL AND a.body_text <> ''
      AND EXISTS (
            SELECT 1 FROM study_facts sf4
            WHERE sf4.item_type = 'aim' AND sf4.item_id = a.paragraph_number AND sf4.status = 'live'
          )
      AND a.paragraph_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'aim')
      AND (p_levels IS NULL OR aim_all_levels(a.chapter, a.paragraph_number) && p_levels)
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
      -- The fix: only surface an AC as a "new" card once it has a real
      -- authored fact -- otherwise the client falls back to the bare
      -- title-as-question placeholder. See header comment.
      AND EXISTS (
            SELECT 1 FROM study_facts sf
            WHERE sf.item_type = 'ac' AND sf.item_id = c.document_number AND sf.status = 'live'
          )
      AND c.document_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'ac')
      AND NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR ac_all_levels(c.subject_series, c.document_number) && p_levels)
      AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
    ORDER BY (ac_relevance_weight(c.document_number) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh_dictionary AS (
    SELECT d.slug AS item_id, 'dictionary' AS item_type, d.term,
      d.senses->0->>'definition' AS definition, true AS is_new
    FROM dictionary_terms d
    WHERE (p_item_types IS NULL OR 'dictionary' = ANY(p_item_types))
      AND d.category IN ('handbook', 'mnemonic')
      AND d.senses->0->>'definition' IS NOT NULL AND d.senses->0->>'definition' <> ''
      AND (p_levels IS NULL OR dictionary_all_levels(d.slug) && p_levels)
      AND d.slug NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'dictionary')
      AND (p_category_classes IS NULL OR dictionary_category_classes(d.slug) IS NULL OR dictionary_category_classes(d.slug) && p_category_classes)
    ORDER BY (CASE WHEN d.category = 'mnemonic' THEN 1 ELSE 0 END) DESC, random()
    LIMIT p_limit
  ),
  fresh_cfr49 AS (
    SELECT f5.section_number AS item_id, 'cfr49' AS item_type,
      '49 CFR ' || f5.section_number || ' ' || regexp_replace(f5.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') AS term,
      f5.body_text AS definition, true AS is_new
    FROM cfr49_sections f5
    WHERE (p_item_types IS NULL OR 'cfr49' = ANY(p_item_types))
      AND f5.body_text IS NOT NULL AND f5.body_text <> ''
      AND f5.title IS NOT NULL AND f5.title <> ''
      -- Built with the live-fact gate from day one -- see fresh_ac's own
      -- comment above for why (this is the SAME fix, just never retrofitted
      -- onto fresh_far/fresh_aim until this same migration).
      AND EXISTS (
            SELECT 1 FROM study_facts sf3
            WHERE sf3.item_type = 'cfr49' AND sf3.item_id = f5.section_number AND sf3.status = 'live'
          )
      AND f5.section_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'cfr49')
      AND NOT (cfr49_knowledge_levels(f5.part) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR cfr49_all_levels(f5.part, f5.section_number) && p_levels)
      AND (p_category_classes IS NULL OR cfr49_category_classes(f5.part, f5.title) IS NULL OR cfr49_category_classes(f5.part, f5.title) && p_category_classes)
    ORDER BY (cfr49_relevance_weight(f5.part) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh AS (
    SELECT * FROM fresh_pcg
    UNION ALL SELECT * FROM fresh_far
    UNION ALL SELECT * FROM fresh_aim
    UNION ALL SELECT * FROM fresh_ac
    UNION ALL SELECT * FROM fresh_dictionary
    UNION ALL SELECT * FROM fresh_cfr49
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
$function$
;
