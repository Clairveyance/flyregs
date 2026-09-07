-- Part 107 gets its own filter box; unmanned/administrative parts leave the
-- pilot levels. (2026-09-07)
--
-- RC, after seeing the measured composition of the Student box: "option 1,
-- give 107 its own box."
--
-- WHAT WAS WRONG
-- The Student level held 310 FAR sections and only 36% of them were Part 61 or
-- 91. The rest was Part 107 (54 sections), Remote ID (89), drone registration
-- (48), rockets/moored balloons (101), ultralights (103), and registration/
-- marking paperwork (45, 47). A student pilot filtering to "Student" was
-- getting a bank that was majority drone and administrative material. That is
-- the other half of RC's long-running "irrelevant question" complaint -- a
-- perfectly-worded Remote ID question is still wrong in a PPL student's deck.
--
-- far_knowledge_levels already predicted this change in its own comment:
-- "No dedicated 'remote pilot' level exists in today's filter taxonomy; filed
-- under student/private for now... Revisit if a dedicated level is ever added."
-- This adds it.
--
-- TWO PLACES, NOT ONE. far_all_levels() prefers a per-section override row in
-- far_section_levels and only falls back to far_knowledge_levels(). There are
-- 123 override rows across these parts, so changing the function alone would
-- have changed nothing at all for them. Both are updated here.
-- Snapshot taken first: CODE_BACKUPS/content_snapshots/
-- far_section_levels_remote_pilot_level_split_20260907_131939.json
--
-- SAFE FOR THE SHIPPED BUILD (B40). Its client never sends 'remote_pilot', so
-- it simply never selects the new box; and its Student/Private filters start
-- returning a smaller, more relevant pool the moment this runs -- an
-- improvement that needs no new build. Existing duels are unaffected: their
-- questions are already materialised in challenge_questions.

begin;

-- 1. The fallback classifier.
CREATE OR REPLACE FUNCTION public.far_knowledge_levels(p_part text, p_subpart text)
 RETURNS text[] LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_part = '61' AND p_subpart IN ('A','B','C','J')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart IN ('D','E')
      THEN ARRAY['private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'F'
      THEN ARRAY['commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'G' THEN ARRAY['atp']
    WHEN p_part = '61' AND p_subpart IN ('H','I','K') THEN ARRAY['cfi']
    WHEN p_part = '61' THEN ARRAY['student','private','commercial','atp','cfi']

    WHEN p_part = '91' AND p_subpart = 'I' THEN ARRAY['atp','cfi']
    WHEN p_part = '91' AND p_subpart = 'K' THEN ARRAY['atp','cfi']
    WHEN p_part = '91'
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']

    WHEN p_part IN ('71','73')
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- 43 (preventive maintenance a pilot may perform) and 39 (ADs) stay with
    -- pilots -- both are genuinely pilot-testable. 45 and 47 move to mechanic
    -- only: N-number marking and registry paperwork are administrative, and
    -- what a PILOT must know about carrying a registration certificate is
    -- already in 91.203.
    WHEN p_part IN ('43','39')
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']
    WHEN p_part IN ('45','47') THEN ARRAY['mechanic']

    WHEN p_part IN ('1','67')
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- Moored balloons, kites, amateur rockets (101) and ultralight vehicles
    -- (103) are not part of any pilot-certificate curriculum -- neither
    -- requires a certificate to operate. Still fully browsable and
    -- searchable; simply not drawn into a certificate study deck.
    WHEN p_part IN ('101','103') THEN ARRAY['not_applicable']

    WHEN p_part = '68' THEN ARRAY['private']
    WHEN p_part IN ('93','99','105') THEN ARRAY['private','commercial','atp','cfi']
    WHEN p_part IN ('95','139') THEN ARRAY['commercial','atp','cfi']
    WHEN p_part IN ('133','137') THEN ARRAY['commercial']
    WHEN p_part = '119' THEN ARRAY['commercial','atp','cfi']
    WHEN p_part IN ('117','121','125','135','136','5','120','129','110') THEN ARRAY['atp']
    WHEN p_part = '111' THEN ARRAY['atp','cfi']
    WHEN p_part = '63' THEN ARRAY['atp']
    WHEN p_part IN ('141','142','60') THEN ARRAY['cfi']
    WHEN p_part IN ('21','23','25','27','29','31','33','34','35','36','65','145','147','183','26','38')
      THEN ARRAY['mechanic']

    -- Small UAS (107) with its Remote ID (89) and registration (48)
    -- satellites: a real, separate, testable certificate track that now has
    -- its own box instead of diluting the manned-pilot levels.
    WHEN p_part IN ('107','89','48') THEN ARRAY['remote_pilot']

    WHEN p_part IN ('3','11','13','14','15','16','17','22','49','77','97',
                     '150','151','152','153','155','156','157','158','161','169','170',
                     '171','185','187','189','193','194','198')
      THEN ARRAY['not_applicable']
    ELSE ARRAY['not_applicable']
  END;
$function$;

-- 2. The per-section overrides, which take precedence over the function.
UPDATE far_section_levels l
   SET levels = ARRAY['remote_pilot']
  FROM far_sections f
 WHERE f.section_number = l.section_number
   AND f.part IN ('107','89','48');

UPDATE far_section_levels l
   SET levels = ARRAY['not_applicable']
  FROM far_sections f
 WHERE f.section_number = l.section_number
   AND f.part IN ('101','103');

UPDATE far_section_levels l
   SET levels = ARRAY['mechanic']
  FROM far_sections f
 WHERE f.section_number = l.section_number
   AND f.part IN ('45','47');

commit;
