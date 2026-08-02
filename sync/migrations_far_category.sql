-- ============================================================================
-- Category/Class filter: classify FAR content by PART, not just by title
--                                                            2026-07-31
--
-- Measured during the filter audit: 5 of the 10 Category/Class chips
-- (ASEL, ASES, AMEL, AMES, GYRO) matched ZERO material anywhere in the
-- corpus. category_classes_from_text() only reads a title, and FAA titles
-- essentially never say "single-engine land" or "gyroplane".
--
-- Those chips were not broken -- the filter is exclusion-shaped, so picking
-- ASEL still correctly removed the 69 helicopter/glider/balloon/powered-lift
-- items -- but picking one could never ADD anything, and GYRO in particular
-- selected no gyroplane material at all.
--
-- The fix is NOT to scan body text. Measured that too, and it is actively
-- wrong: § 91.155 (Basic VFR weather minimums), § 91.119 (Minimum safe
-- altitudes) and § 61.57 (Recent flight experience) all mention helicopters
-- because they contain a helicopter-specific PARAGRAPH. Classifying them as
-- HELI would strip core airman knowledge out of an ASEL pilot's pool. Those
-- sections are correctly left unclassified today ("applies to everyone").
--
-- Instead, classify by the structure the FAA already provides -- whole parts
-- that exist for exactly one aircraft category. Same principle as
-- far_knowledge_levels(): real FAR structure, not a text guess.
--
--   Part 23  Airworthiness Standards: Normal Category AIRPLANES
--              -> ASEL, ASES, AMEL, AMES   (all four airplane classes)
--   Part 25  Airworthiness Standards: Transport Category AIRPLANES
--              -> AMEL, AMES               (transport category is multiengine)
--   Part 27  Airworthiness Standards: Normal Category ROTORCRAFT
--   Part 29  Airworthiness Standards: Transport Category ROTORCRAFT
--              -> HELI, GYRO   (per § 1.1 the rotorcraft CATEGORY contains
--                               both the helicopter and gyroplane classes)
--   Part 31  Airworthiness Standards: Manned Free BALLOONS
--              -> BALLOON
--
-- All five are mechanic-level parts (far_knowledge_levels returns
-- {mechanic}), so this surfaces category-specific airworthiness material
-- exactly where it belongs -- a Mechanic + HELI session -- and keeps it out
-- of pilot-level sessions, which is what the level filter already does.
--
-- Title matching is still unioned in, so a helicopter-titled § 135.207
-- outside these parts keeps its HELI classification.
-- ============================================================================

create or replace function public.far_category_classes(p_part text, p_title text)
returns text[]
language sql
immutable
as $function$
  select nullif(
    array(
      select distinct cc from unnest(
        coalesce(category_classes_from_text(p_title), array[]::text[])
        || case p_part
             when '23' then array['ASEL','ASES','AMEL','AMES']
             when '25' then array['AMEL','AMES']
             when '27' then array['HELI','GYRO']
             when '29' then array['HELI','GYRO']
             when '31' then array['BALLOON']
             else array[]::text[]
           end
      ) as cc
      order by cc
    ),
    array[]::text[]
  );
$function$;
