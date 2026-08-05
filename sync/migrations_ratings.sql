-- ============================================================================
-- "Rating" filter dimension: Instrument + Airframe + Powerplant
--                                                            2026-08-04
--
-- RC, on My Fleet: "the knowledge filter doesn't have IFR. that's a big
-- one... that's a unique knowledge set beyond private and COM" and "ideally
-- we could find some maintenance-centric filters, to allow A&Ps, etc to
-- filter their knowledge as well" -- then, approving the recommendation
-- logged in flyregs_pending.md: "but yes, we need to build out the
-- intelligent filter for it. both to exclude IFR stuff w/o it, and include
-- w/ it on" / "yeah fine, A&P goes in the rating dimen as well."
--
-- WHY A THIRD DIMENSION, NOT A KNOWLEDGE-LEVEL VALUE: checked before
-- proposing anything (see flyregs_pending.md's full writeup) -- KnowledgeLevel
-- is a certificate-PROGRESSION axis (student -> private -> commercial ->
-- atp), and instrument/A&P don't fit it (a private, commercial, or ATP pilot
-- can each be instrument-rated or not, same as category/class already being
-- its own axis rather than a level value). This is the same shape as
-- Category/Class (migrations_far_category.sql /
-- migrations_aim_category.sql / migrations_ac_category.sql) and reuses that
-- exact pattern: one typed classification function per content type,
-- returning text[] or SQL NULL via nullif(), threaded through
-- get_study_pool_count / get_study_queue / create_challenge as a new
-- p_ratings text[] parameter.
--
-- SEMANTICS -- deliberately Category/Class's "NULL means universal" rule,
-- NOT Knowledge Level's "empty array means excluded" rule (see
-- gotcha_null_means_everything_filters.md for why those two dimensions
-- intentionally differ): RC's own framing was "exclude IFR stuff w/o it,
-- and include w/ it on" -- i.e. IFR-TAGGED content is what gets hidden by
-- default, not general/untagged content. A FAR section that's neither
-- instrument- nor A&P-specific (the vast majority of the corpus) must stay
-- visible no matter what Rating chips are selected, exactly like an
-- ASEL-only filter doesn't hide a category-agnostic FAR section. So every
-- function below returns NULL (via nullif) for "not rating-specific," never
-- an empty array, and every caller uses the same
-- "(p_ratings IS NULL OR fn(...) IS NULL OR fn(...) && p_ratings)" shape
-- already established for p_category_classes.
--
-- INSTRUMENT -- FAR: verified against LIVE section titles (not guessed from
-- part/subpart alone, since Part 91 Subpart B mixes VFR and IFR sections
-- under one letter):
--   91.151/153/155/157/159        VFR-specific -- deliberately NOT tagged
--   91.167-91.193 (16 real sections, listed explicitly below; 91.162-165 and
--     91.195-199 are [Reserved])   IFR-specific -- confirmed by title
--     ("Fuel requirements for flight in IFR conditions", "IFR cruising
--     altitude or flight level", "Category II and III operations", etc.)
--   Part 95 (IFR Altitudes) and Part 97 (Standard Instrument Procedures) --
--     entirely instrument-specific BY DEFINITION, not a per-section
--     judgment call, so tagged at the whole-part level.
--   61.65 "Instrument rating requirements" and 61.66 "Enhanced Flight
--     Vision System Pilot Requirements" -- both confirmed live.
--   Part 71 (airspace classes, jet routes) deliberately NOT tagged despite
--     Class A / jet routes being IFR-only in practice -- most of Part 71
--     (Class B/C/D/E, reporting points) applies to VFR pilots too, and
--     splitting it would need the same section-level care as Part 91 got;
--     flagged here rather than guessed, matching this project's own
--     precedent (see migrations_aim_category.sql's AC/P-CG gaps) of
--     disclosing a gap instead of a weak attempt.
--
-- INSTRUMENT -- AIM: chapter 5, paragraph_number LIKE '5-4-%' -- the EXACT
-- same signal gotcha_aim_chapter_level_too_coarse already proved clean for
-- Knowledge Level (all of 5-4 is Instrument Approach Procedures: STARs,
-- IAP charts, missed approach, CAT II/III, RNP AR, EFVS-on-approach -- every
-- subparagraph checked live is instrument-approach-specific). Reused
-- verbatim rather than re-derived.
--
-- INSTRUMENT -- P/CG: no chapter/part structure to lean on (same gap
-- migrations_aim_category.sql already flagged for Category/Class), but
-- unlike Category/Class, a live check found real signal in the TERM field
-- itself -- 18 terms contain "instrument" (INSTRUMENT APPROACH, INSTRUMENT
-- LANDING SYSTEM (ILS), etc.) and 13 contain "IFR" (IFR FLIGHT,
-- ABBREVIATED IFR FLIGHT PLANS, etc.), all genuinely instrument-specific on
-- inspection. Text-matched on the term, same scope as
-- category_classes_from_text().
--
-- INSTRUMENT -- AC: no clean series-level signal found (unlike Category/
-- Class, where AC series numbers parallel FAR part numbers) -- instrument-
-- relevant ACs are scattered across series 20/90/91/120 with no single
-- series boundary. NOT attempted; AC's contribution to the study/duels pool
-- is unaffected by the Instrument chip either way (always passes, same as
-- any other untagged content). Flagged here, not guessed.
--
-- AIRFRAME / POWERPLANT -- FAR & AC: 14 CFR Part 147's own curriculum
-- appendices (checked live via eCFR/Cornell mirrors before writing this)
-- define Airframe/Powerplant by SUBJECT MATTER (wood structures, sheet
-- metal, hydraulics for Airframe; reciprocating/turbine engines, fuel
-- systems, propellers for Powerplant), not by citing other CFR parts by
-- number -- there is no regulatory crosswalk to lean on the way Category/
-- Class leaned on AC-series-parallels-FAR-part. Also checked: Part 43
-- Appendix A (which DOES split "Airframe Major Alterations" from
-- "Powerplant Major Alterations" in the real regulation) does not exist as
-- its own row in this corpus -- far_sections has no appendix-level entries
-- for Part 43 -- so that finer signal isn't available here either.
-- Classified at the PART level instead, using the well-established (not
-- contested) aviation-industry fact that Part 33 (Aircraft Engines) and
-- Part 35 (Propellers) ARE the powerplant airworthiness standards, and Part
-- 23/25/27/29/31 (airplane/rotorcraft/balloon airworthiness standards) are
-- structural/airframe standards -- same "AC series parallels FAR part"
-- convention ac_category_classes/far_category_classes already established.
-- General/administrative mechanic-relevant parts (21, 39, 43, 45, 65, 145,
-- 147, 183 -- certification procedures, maintenance record-keeping, mechanic
-- certification itself, repair stations) are deliberately left untagged:
-- under the NULL-means-universal rule above, that's identical in effect to
-- tagging them both, so no information is lost, and it avoids overclaiming
-- precision Part 147's own curriculum doesn't actually specify.
--
-- AIRFRAME / POWERPLANT -- AIM & P/CG: no signal at all -- AIM has no
-- maintenance content, and a live check found zero P/CG terms matching
-- powerplant/airframe/propeller/reciprocating engine/turbine engine (P/CG is
-- ATC/procedural terminology, not aircraft-systems vocabulary). Both left
-- untagged (their rating functions only ever produce 'instrument' or NULL).
--
-- DISTRACTORS in create_challenge: p_ratings is NOT applied to distractor
-- selection, matching p_category_classes' own existing behavior (neither is
-- applied there today) rather than p_levels' (which IS applied, to stop a
-- level-mismatched distractor from giving the answer away by elimination --
-- see that function's own comment). Rating is the newer dimension's sibling
-- in shape, not Level's, so it follows Category/Class's precedent here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.far_ratings(p_part text, p_section_number text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT nullif(
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p_part = '91' AND p_section_number IN (
        '91.167','91.169','91.171','91.173','91.175','91.176','91.177',
        '91.179','91.180','91.181','91.183','91.185','91.187','91.189',
        '91.191','91.193'
      ) THEN 'instrument' END,
      CASE WHEN p_part IN ('95','97') THEN 'instrument' END,
      CASE WHEN p_part = '61' AND p_section_number IN ('61.65','61.66') THEN 'instrument' END,
      CASE WHEN p_part IN ('33','34','35') THEN 'powerplant' END,
      CASE WHEN p_part IN ('23','25','27','29','31') THEN 'airframe' END
    ], NULL),
    ARRAY[]::text[]
  );
$function$;

CREATE OR REPLACE FUNCTION public.aim_ratings(p_chapter text, p_paragraph_number text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT nullif(
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p_chapter = '5' AND p_paragraph_number LIKE '5-4-%' THEN 'instrument' END
    ], NULL),
    ARRAY[]::text[]
  );
$function$;

CREATE OR REPLACE FUNCTION public.ac_ratings(p_series text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT nullif(
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p_series IN ('33','34','35') THEN 'powerplant' END,
      CASE WHEN p_series IN ('23','25','27','29','31') THEN 'airframe' END
    ], NULL),
    ARRAY[]::text[]
  );
$function$;

CREATE OR REPLACE FUNCTION public.pcg_ratings(p_term text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT nullif(
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p_term ~* 'instrument|ifr' THEN 'instrument' END
    ], NULL),
    ARRAY[]::text[]
  );
$function$;

-- challenges.ratings mirrors challenges.category_classes -- the Challenger's
-- Rating pick, persisted at creation so both players (and a later rematch)
-- see the same filter, same as every other dimension on this table.
ALTER TABLE public.challenges ADD COLUMN IF NOT EXISTS ratings text[];

-- DROP first, for all 3 of these -- CREATE OR REPLACE does NOT replace an
-- existing function when the argument list changes shape (even just
-- appending one optional trailing param): Postgres dispatches by full
-- signature, so it silently created a SECOND overload alongside the old
-- 3/4/5-arg version instead of replacing it -- confirmed live (both
-- versions showed up in pg_proc after the first deploy attempt). Explicit
-- drops of the exact old signatures avoid leaving that stale duplicate
-- around.
DROP FUNCTION IF EXISTS public.get_study_pool_count(text[], text[], text[]);
DROP FUNCTION IF EXISTS public.get_study_queue(integer, text[], text[], text[]);
DROP FUNCTION IF EXISTS public.create_challenge(uuid[], integer, text[], text[], text[]);

CREATE OR REPLACE FUNCTION public.get_study_pool_count(p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND (p_levels IS NULL OR pcg_knowledge_levels(p.slug) && p_levels)
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes)
         AND (p_ratings IS NULL OR pcg_ratings(p.term) IS NULL OR pcg_ratings(p.term) && p_ratings))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND f.section_number IN (SELECT section_number FROM study_far_sections)
         AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
         AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
         AND (p_ratings IS NULL OR far_ratings(f.part, f.section_number) IS NULL OR far_ratings(f.part, f.section_number) && p_ratings))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND (p_levels IS NULL OR aim_knowledge_levels(a.chapter, a.paragraph_number) && p_levels)
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes)
         AND (p_ratings IS NULL OR aim_ratings(a.chapter, a.paragraph_number) IS NULL OR aim_ratings(a.chapter, a.paragraph_number) && p_ratings))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
         AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
         AND (p_ratings IS NULL OR ac_ratings(c.subject_series) IS NULL OR ac_ratings(c.subject_series) && p_ratings));
$function$;

CREATE OR REPLACE FUNCTION public.get_study_queue(p_limit integer DEFAULT 20, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
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
      AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
      AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
      AND (p_ratings IS NULL OR far_ratings(f.part, f.section_number) IS NULL OR far_ratings(f.part, f.section_number) && p_ratings)
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
      AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
      AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
      AND (p_ratings IS NULL OR ac_ratings(c.subject_series) IS NULL OR ac_ratings(c.subject_series) && p_ratings)
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

CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
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
          and (p_ratings is null or pcg_ratings(term) is null or pcg_ratings(term) && p_ratings)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where (p_levels is null or far_knowledge_levels(f2.part, f2.subpart_letter) is null or far_knowledge_levels(f2.part, f2.subpart_letter) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
          and (p_ratings is null or far_ratings(f2.part, f2.section_number) is null or far_ratings(f2.part, f2.section_number) && p_ratings)
        order by random() limit p_question_count * 3
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
        where (p_levels is null or ac_knowledge_levels(c2.subject_series) is null or ac_knowledge_levels(c2.subject_series) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
          and (p_ratings is null or ac_ratings(c2.subject_series) is null or ac_ratings(c2.subject_series) && p_ratings)
        order by random() limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    -- Distractors respect the SAME knowledge-level filter as the question
    -- pool. Without this a Student-level duel offered Part 121/125 sections
    -- as decoys, which both gives the answer away by elimination and quizzes
    -- on material the filter exists to exclude. (p_ratings is deliberately
    -- NOT applied here, matching p_category_classes' own existing scope --
    -- see this file's header comment.)
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

-- Surfaces the stored ratings pick alongside item_types/levels/
-- category_classes -- same reasoning as those three: a Duel opponent should
-- see what they're about to be quizzed on, and a rematch needs to read the
-- original pick back. DROP first -- get_my_challenges() takes no
-- parameters, so CREATE OR REPLACE can't widen its RETURNS TABLE shape
-- (Postgres: "cannot change return type of existing function... Row type
-- defined by OUT parameters is different"); confirmed live the whole batch
-- rolled back atomically on that error, nothing partial to clean up.
DROP FUNCTION IF EXISTS public.get_my_challenges();
CREATE OR REPLACE FUNCTION public.get_my_challenges()
 RETURNS TABLE(challenge_id uuid, am_challenger boolean, status text, my_status text, question_count integer, my_answered_count integer, created_at timestamp with time zone, item_types text[], levels text[], category_classes text[], ratings text[], others jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select
    c.id,
    c.challenger_id = auth.uid(),
    c.status,
    mycp.status,
    c.question_count,
    (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
       where cq.challenge_id = c.id and ca.user_id = auth.uid())::int,
    c.created_at,
    c.item_types,
    c.levels,
    c.category_classes,
    c.ratings,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', ocp.user_id,
        'label', coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'status', ocp.status,
        'answeredCount', (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = ocp.user_id)
      ) order by ocp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants ocp
      join auth.users u on u.id = ocp.user_id
      where ocp.challenge_id = c.id and ocp.user_id != auth.uid()
    )
  from challenges c
  join challenge_participants mycp on mycp.challenge_id = c.id and mycp.user_id = auth.uid()
  order by c.created_at desc;
end;
$function$;
