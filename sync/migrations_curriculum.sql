-- SUPERSEDED 2026-08-04 -- the function bodies below have drifted from
-- what's actually live (aim_knowledge_levels gained a 2nd parameter,
-- far/ac_knowledge_levels' ELSE branch changed NULL -> ARRAY[]::text[],
-- get_study_pool_count/get_study_queue gained a study_far_sections join,
-- none of it reflected here). Kept as-is for history, per this project's
-- own convention -- but for the CURRENT state of every classification
-- function, see migrations_classification_current.sql, not this file.
--
-- Real knowledge-level curriculum for Study Mode / Duels.
--
-- THE BUG: far_knowledge_levels() classified only Part 61 subparts, 121/135/117
-- and 43/65/145/21, returning NULL for everything else -- and the callers wrote
--     (p_levels IS NULL OR far_knowledge_levels(...) IS NULL OR ... && p_levels)
-- so every UNCLASSIFIED section matched EVERY level. Measured effect: the
-- "student" filter returned 3,702 of 4,602 items (80%), and a 60-card student
-- sample was topped by Part 29 (transport rotorcraft airworthiness), Part 25
-- (transport airplane airworthiness), Part 125 and Part 161 (airport noise) --
-- none of which a student pilot ever studies. Part 61 contributed 2 cards.
--
-- AIM had NO level filtering whatsoever.
--
-- Levels are CUMULATIVE, matching how training actually works: a private pilot
-- still drills student material; a CFI still needs commercial knowledge.

CREATE OR REPLACE FUNCTION public.far_knowledge_levels(p_part text, p_subpart text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    -- Part 61 — pilot certification, split by the subpart that governs
    -- each certificate level. Everyone from student up needs the general
    -- rules (A/B) and the student-pilot rules (C); sport (J) sits alongside.
    WHEN p_part = '61' AND p_subpart IN ('A','B','C','J')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart IN ('D','E')
      THEN ARRAY['private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'F'
      THEN ARRAY['commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'G'
      THEN ARRAY['atp']
    WHEN p_part = '61' AND p_subpart IN ('H','I','K')
      THEN ARRAY['cfi']
    WHEN p_part = '61'
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- Part 91 — general operating and flight rules. The single most
    -- important part for every pilot certificate, at every level.
    WHEN p_part = '91'
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']

    -- Airspace definition (71) and special-use airspace (73): core airspace
    -- knowledge, tested from the student written onward.
    WHEN p_part IN ('71','73')
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- Maintenance a pilot may perform / must verify, plus registration and
    -- marking. Pilots meet these; mechanics own them.
    WHEN p_part IN ('43','45','47','39')
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']

    -- Commercial operations gateway.
    WHEN p_part = '119' THEN ARRAY['commercial','atp','cfi']

    -- Air carrier / commuter ops and flight-time limits — ATP territory.
    WHEN p_part IN ('117','121','125','135','136') THEN ARRAY['atp']

    -- Training organisations — instructor territory.
    WHEN p_part IN ('141','142') THEN ARRAY['cfi']

    -- Certification/airworthiness STANDARDS and the people who apply them.
    -- These are exactly what was polluting the student deck.
    WHEN p_part IN ('21','23','25','27','29','31','33','34','35','36','65','145','147','183')
      THEN ARRAY['mechanic']

    -- Everything else (airports 150/151/152/161, navaids 171, procedures 97,
    -- administrative 11/13/16/17, etc.) is reference material, not study
    -- material. Returns NULL, and the callers now EXCLUDE NULL when a level
    -- filter is active instead of treating it as "matches everything".
    ELSE NULL
  END;
$function$;


-- AIM chapters, which previously had no level scoping at all.
-- Chapter numbering: 1 Navigation Aids, 2 Aeronautical Lighting, 3 Airspace,
-- 4 ATC, 5 Air Traffic Procedures, 6 Emergency, 7 Safety of Flight,
-- 8 Medical Facts, 9 Aeronautical Charts, 10 Helicopter, 11 UAS.
CREATE OR REPLACE FUNCTION public.aim_knowledge_levels(p_chapter text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    -- Core airmanship every certificate level is tested on.
    WHEN p_chapter IN ('1','2','3','4','5','6','7','8','9')
      THEN ARRAY['student','private','commercial','atp','cfi']
    -- Helicopter ops — relevant once rotorcraft is in play, not to a
    -- fixed-wing student's written.
    WHEN p_chapter = '10' THEN ARRAY['commercial','atp','cfi']
    -- UAS.
    WHEN p_chapter = '11' THEN ARRAY['commercial','atp','cfi']
    ELSE NULL
  END;
$function$;


-- AC subject series, by FAA's own numbering scheme. Previously only
-- 121/135/117 -> atp and 43/65/145/21 -> mechanic; every other series
-- returned NULL and leaked into every level filter.
CREATE OR REPLACE FUNCTION public.ac_knowledge_levels(p_series text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    -- 00 General, 60 Airmen training, 61 Pilot certification, 67 Medical,
    -- 70 Airspace, 90/91 Air traffic + general operating rules.
    -- This is the pilot curriculum, at every certificate level.
    WHEN p_series IN ('00','60','61','67','70','90','91')
      THEN ARRAY['student','private','commercial','atp','cfi']
    -- Air carrier / commercial operations.
    WHEN p_series IN ('117','119','120','121','125','135')
      THEN ARRAY['atp']
    -- Pilot schools and instructors.
    WHEN p_series IN ('140','141','142')
      THEN ARRAY['cfi']
    -- Airworthiness, maintenance, certification standards, engines/props,
    -- marking, ADs, mechanics and designees.
    WHEN p_series IN ('20','21','23','25','27','29','33','35','36','39','43','45','65','147','183')
      THEN ARRAY['mechanic']
    ELSE NULL
  END;
$function$;


-- ── Callers: remove the "unclassified matches everything" escape hatch ────
-- The old predicate was
--     (p_levels IS NULL OR x_knowledge_levels(...) IS NULL OR ... && p_levels)
-- The middle clause is what let Part 25/29/125/161 into a student deck.
-- Dropped below. Note the DELIBERATE asymmetry with category/class, which
-- KEEPS its permissive NULL: an unclassified LEVEL means "we don't know, so
-- don't claim it's student material", whereas an unclassified CATEGORY means
-- "not category-specific" -- FAR 91.103 preflight action really does apply to an
-- ASEL pilot, so it must still appear under an ASEL filter.
--
-- AIM and P/CG also gain level filtering here; AIM previously had NONE, so
-- every paragraph matched every level.

CREATE OR REPLACE FUNCTION public.get_study_pool_count(
  p_item_types text[] DEFAULT NULL::text[],
  p_levels text[] DEFAULT NULL::text[],
  p_category_classes text[] DEFAULT NULL::text[]
)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
AS $function$
  SELECT
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL
              OR category_classes_from_text(p.term || ' ' || p.definition) IS NULL
              OR category_classes_from_text(p.term || ' ' || p.definition) && p_category_classes))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
         AND (p_category_classes IS NULL
              OR category_classes_from_text(f.title || ' ' || f.body_text) IS NULL
              OR category_classes_from_text(f.title || ' ' || f.body_text) && p_category_classes))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_levels IS NULL OR aim_knowledge_levels(a.chapter) && p_levels)
         AND (p_category_classes IS NULL
              OR category_classes_from_text(coalesce(a.title,'') || ' ' || a.body_text) IS NULL
              OR category_classes_from_text(coalesce(a.title,'') || ' ' || a.body_text) && p_category_classes))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
         AND (p_category_classes IS NULL
              OR category_classes_from_text(c.title || ' ' || c.description) IS NULL
              OR category_classes_from_text(c.title || ' ' || c.description) && p_category_classes));
$function$;
