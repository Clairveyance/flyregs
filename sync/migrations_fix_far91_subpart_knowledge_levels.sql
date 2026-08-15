-- Real bug found 2026-08-12 by the filter-correctness agent during RC's full
-- app re-sweep, live-reproduced twice in actual Student-filtered Study Mode
-- sessions (not just a code read): far_knowledge_levels() had a single
-- blanket branch for ALL of Part 91 (`student,private,commercial,atp,cfi,
-- mechanic`), unlike Part 61 which already differentiates carefully by
-- subpart. Confirmed live: a Student-filtered Study Mode session surfaced
-- real questions from
--   § 91.1023 "Besides crewmembers, who else must the program manager
--     furnish the manual to?" (Subpart K, Fractional Ownership Operations
--     -- turbine/transport-category program-manager management specs)
--   § 91.805/91.809/91.811 (Subpart I, Noise Standards -- Stage 2 subsonic
--     compliance-schedule exceptions, agricultural/firefighting noise
--     limits)
-- Neither is remotely student-pilot-testable material; both are
-- operator/program-level regulatory-compliance content. Subpart K alone is
-- 74 of 254 Part 91 sections in the study pool (29%) -- a large, systematic
-- leak, not an edge case.
--
-- Scope note: Subparts F/G/H/L/M/N carry similarly advanced titles by their
-- own text (large/turbine/transport-category equipment, international
-- SFAR prohibitions, RVSM authorization, aging-aircraft inspection
-- programs) and are very likely the same class of leak -- but were NOT
-- individually live-reproduced the way I and K were, so they are
-- deliberately left untouched here rather than reclassified on title-text
-- inference alone. This project has been burned before by exactly this
-- kind of unverified broad reclassification (see the AC parser's own
-- "90 docs corrupted for 7 real fixes" lesson) -- flagging for a follow-up
-- pass with the same live-reproduction rigor, not guessing now.

create or replace function public.far_knowledge_levels(p_part text, p_subpart text)
returns text[]
language sql
immutable
as $function$
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

    -- Part 91 — general operating and flight rules, the single most
    -- important part for every pilot certificate at every level -- EXCEPT
    -- two subparts confirmed (live-reproduced 2026-08-12) to be advanced
    -- operator/program-compliance content, not pilot-certificate material:
    WHEN p_part = '91' AND p_subpart = 'I'
      -- Noise Standards: Stage 2/3 compliance schedules, agricultural/
      -- firefighting noise limits, sonic boom -- operator compliance-
      -- deadline content, not pilot-testable knowledge at any cert level
      -- below the people actually managing part-91 compliance programs.
      THEN ARRAY['atp','cfi']
    WHEN p_part = '91' AND p_subpart = 'K'
      -- Fractional Ownership Operations: program-manager management specs,
      -- augmented-crew requirements, operational-control responsibility --
      -- turbine/transport-category program administration, confirmed live
      -- polluting the Student pool.
      THEN ARRAY['atp','cfi']
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

    -- Definitions/abbreviations, medical certification, and basic
    -- airspace-adjacent operating knowledge every pilot certificate tests.
    WHEN p_part IN ('1','67')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part IN ('101','103')
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- BasicMed — private-privilege specific.
    WHEN p_part = '68' THEN ARRAY['private']

    -- Special air traffic rules, ADIZ/security, parachute ops, military
    -- special-use coordination — real testable airspace-operations
    -- knowledge, from private certificate onward.
    WHEN p_part IN ('93','99','105')
      THEN ARRAY['private','commercial','atp','cfi']

    -- IFR en route minimum altitudes, airport certification standards —
    -- commercial/instrument-adjacent onward.
    WHEN p_part IN ('95','139')
      THEN ARRAY['commercial','atp','cfi']

    -- Rotorcraft external-load and agricultural operations — real,
    -- certificate-endorsement-specific commercial content.
    WHEN p_part IN ('133','137')
      THEN ARRAY['commercial']

    -- Commercial operations gateway.
    WHEN p_part = '119' THEN ARRAY['commercial','atp','cfi']

    -- Air carrier / commuter ops, flight-time limits, SMS, foreign air
    -- carriers, PRD-adjacent definitions — ATP territory.
    WHEN p_part IN ('117','121','125','135','136','5','120','129','110')
      THEN ARRAY['atp']
    WHEN p_part = '111' THEN ARRAY['atp','cfi']
    WHEN p_part = '63' THEN ARRAY['atp']

    -- Training organisations, FSTD qualification standards — instructor
    -- territory.
    WHEN p_part IN ('141','142','60')
      THEN ARRAY['cfi']

    -- Certification/airworthiness STANDARDS and the people who apply them.
    -- These are exactly what was polluting the student deck.
    WHEN p_part IN ('21','23','25','27','29','31','33','34','35','36','65','145','147','183','26','38')
      THEN ARRAY['mechanic']

    -- Small UAS (Part 107) and its Remote ID / registration satellites
    -- (89, 48) — a real, separate, testable certificate track. No
    -- dedicated "remote pilot" level exists in today's filter taxonomy;
    -- filed under student/private for now since most 107 holders also
    -- hold or are pursuing a manned-aircraft certificate. Revisit if a
    -- dedicated level is ever added.
    WHEN p_part IN ('107','89','48')
      THEN ARRAY['student','private']

    -- Everything else is confirmed, deliberately, NOT pilot-study
    -- material: rulemaking/petition/hearing/enforcement procedure
    -- (3,11,13,14,15,16,17), historical/defunct programs (22), aircraft
    -- registry/title paperwork (49), obstruction-notification procedure
    -- (77), the legal-authority section for IAPs rather than testable
    -- content itself (97), airport funding/planning/noise/PFC/land-use
    -- programs (150-158,161,169,170), non-federal navaid certification
    -- (171), DOT-wide drug-testing PROGRAM administration as opposed to
    -- the requirement that testing occur (194), and pure legal/admin
    -- process (185,187,189,193,198).
    WHEN p_part IN ('3','11','13','14','15','16','17','22','49','77','97',
                     '150','151','152','153','155','156','157','158','161','169','170',
                     '171','185','187','189','193','194','198')
      THEN ARRAY['not_applicable']

    -- Should be unreachable after this sweep -- every part seen in the
    -- corpus as of 2026-08-11 has an explicit branch above. A future part
    -- appearing here for the first time surfaces as 'not_applicable' by
    -- default (excluded from selection, same as a reviewed one) rather
    -- than silently leaking into the unfiltered pool -- but flag it for
    -- real review rather than trusting the default forever.
    ELSE ARRAY['not_applicable']
  END;
$function$
