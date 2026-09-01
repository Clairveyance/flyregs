-- Add three genuinely instrument-rating sections to the Instrument box (2026-09-01)
--
-- Found while authoring the Instrument question batch: far_ratings() carries a
-- hardcoded 'instrument' list covering 91.167-91.193 and 61.65/61.66, but omits
-- three sections that are unambiguously instrument-rating content. A user
-- filtering Study or Duels to Instrument never saw them:
--
--   61.57  -- paragraph (c) IS instrument currency: six approaches, holding,
--            intercepting and tracking, within 6 calendar months. Arguably the
--            single most-studied instrument rule there is.
--   91.205 -- paragraph (d) is the IFR equipment list (GRABCARD).
--   91.411 -- the altimeter/static system test is required specifically "in
--            controlled airspace under IFR" by its own first sentence.
--
-- PURELY ADDITIVE. far_all_levels() unions the knowledge levels with
-- far_ratings(), so these sections keep every box they already appear in --
-- 61.57 stays in private/commercial/atp/cfi, 91.205 stays in student..cfi,
-- 91.411 stays in commercial/atp/cfi/mechanic. Nobody loses content; the
-- Instrument box gains it.
--
-- Deliberately NOT added: 91.413 (the transponder test applies whenever the
-- transponder is used, VFR included, so it is not instrument-specific) and
-- 91.121 (altimeter settings apply to all operations).

begin;

create or replace function public.far_ratings(p_part text, p_section_number text)
returns text[]
language sql
immutable
as $function$
  SELECT nullif(
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p_part = '91' AND p_section_number IN (
        '91.167','91.169','91.171','91.173','91.175','91.176','91.177',
        '91.179','91.180','91.181','91.183','91.185','91.187','91.189',
        '91.191','91.193',
        -- added 2026-09-01: IFR equipment list (d) and the IFR altimeter/
        -- static test, both required reading for the instrument rating.
        '91.205','91.411'
      ) THEN 'instrument' END,
      CASE WHEN p_part IN ('95','97') THEN 'instrument' END,
      -- added 2026-09-01: 61.57(c) is instrument currency itself.
      CASE WHEN p_part = '61' AND p_section_number IN ('61.65','61.66','61.57') THEN 'instrument' END,
      CASE WHEN p_part IN ('33','34','35') THEN 'powerplant' END,
      CASE WHEN p_part IN ('23','25','27','29','31') THEN 'airframe' END
    ], NULL),
    ARRAY[]::text[]
  );
$function$;

commit;
