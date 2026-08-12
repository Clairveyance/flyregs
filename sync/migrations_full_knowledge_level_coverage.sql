-- Every FAR part and AC subject series now gets an EXPLICIT knowledge-level
-- classification -- either a real level set, or the new 'not_applicable'
-- sentinel for content that is genuinely not pilot-study material (airport
-- funding, enforcement procedure, commercial space transportation, etc.).
-- Previously unmapped content fell through to ARRAY[]::text[], which the
-- callers treated as "matches everything" whenever no level filter was
-- active -- so genuinely obscure/non-testable material (Concorde-era noise
-- grandfather clauses, airport snow-shed construction ACs) was fully
-- eligible for random Study Mode / Duels selection. 'not_applicable' is
-- now excluded from selection UNCONDITIONALLY, filtered or not; every
-- other still-missing part/series was reviewed and given a real
-- classification instead of being left to the ELSE branch.
--
-- RC's explicit requirement (2026-08-11): it's fine to exclude
-- non-testable content from SELECTION, but every part/series must be
-- KNOWN and DELIBERATELY classified, not silently defaulted.

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
$function$;

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

    -- Special air traffic rules, ADIZ/security, parachute ops, military
    -- special-use coordination.
    WHEN p_series IN ('93','99','105','210')
      THEN ARRAY['private','commercial','atp','cfi']

    -- Ultralights.
    WHEN p_series = '103'
      THEN ARRAY['student','private','commercial','atp','cfi']

    -- BasicMed.
    WHEN p_series = '68' THEN ARRAY['private']

    -- Small UAS / Remote ID.
    WHEN p_series IN ('107','89')
      THEN ARRAY['student','private']

    -- Air carrier / commercial operations, foreign air carriers, air tours.
    WHEN p_series IN ('117','119','120','121','125','135','129','136')
      THEN ARRAY['atp']

    -- Agricultural and rotorcraft external-load operations.
    WHEN p_series IN ('137','133')
      THEN ARRAY['commercial']

    -- Pilot schools and instructors, plus instrument-procedure-design
    -- guidance (TERPS) -- genuinely CFI/instrument-instructor material.
    WHEN p_series IN ('140','141','142','8260')
      THEN ARRAY['cfi']

    -- Airworthiness, maintenance, certification standards, engines/props,
    -- marking, ADs, mechanics and designees.
    WHEN p_series IN ('20','21','23','25','27','29','33','35','36','39','43','45','65','147','183','34','38','26','145')
      THEN ARRAY['mechanic']

    -- Confirmed, deliberately, NOT pilot-study material: airport
    -- engineering/design/construction guidance aimed at sponsors and
    -- engineers (150), commercial space transportation -- vehicle
    -- operator licenses, launch/reentry safety (413,431,437,440,450,460),
    -- rulemaking petitions (11), non-federal navaid certification (171),
    -- landing-area establishment (170), fees (187), DOT-wide drug-testing
    -- program administration (194).
    WHEN p_series IN ('150','413','431','437','440','450','460','11','171','170','187','194','3')
      THEN ARRAY['not_applicable']

    -- Should be unreachable after this sweep -- every series seen in the
    -- corpus as of 2026-08-11 has an explicit branch above.
    ELSE ARRAY['not_applicable']
  END;
$function$;
