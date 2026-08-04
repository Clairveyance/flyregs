-- ============================================================================
-- Add pcg_category_classes(), fix the one real caller -- 2026-08-04
--
-- FAR/AIM/AC each have their own dedicated *_category_classes() wrapper
-- (far_category_classes, aim_category_classes, ac_category_classes), all
-- built on top of the shared category_classes_from_text() keyword matcher
-- plus a structural fallback (FAR part -> category, etc.). P/CG never got
-- an equivalent function at all -- its one real caller, create_challenge()
-- (Duels question-pool selection), called category_classes_from_text(term)
-- directly, checking only the bare headword.
--
-- Real, if small, gap: 12 of 1332 P/CG terms mention a category keyword
-- (helicopter/VTOL, mostly) in their DEFINITION but not their headword --
-- HELIPORT, HELIPAD, HOVER CHECK, ROTOR WASH, VERTIPAD, VERTIPORT, AIR
-- TAXI, HOVER TAXI, HEIGHT ABOVE LANDING (HAL), VERTICAL TAKEOFF AND
-- LANDING AIRCRAFT (VTOL) -- so a Duel filtered to, say, Helicopter would
-- silently never draw a HELIPORT question even though it's genuinely
-- helicopter-specific content. (AIRCRAFT and TAXI also technically mention
-- "helicopter" in their definitions but are correctly generic terms, not
-- category-specific -- accepted as the same class of imprecision the
-- existing keyword matcher already has everywhere else, not a new
-- lowering of the bar.)
--
-- No structural override needed (P/CG has no FAR-part-style grouping to
-- fall back on the way far_category_classes() does) -- just the same
-- keyword matcher, applied to term + definition instead of term alone.
--
-- Verified live: HELIPORT/HELIPAD/HOVER CHECK/etc. now correctly return
-- {HELI}; a random sample of category-agnostic terms (MINIMUM FUEL,
-- SQUAWK) still correctly return NULL (matches every category, same
-- "NULL means everything" semantics used corpus-wide -- see
-- gotcha_null_means_everything_filters).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.pcg_category_classes(p_term text, p_definition text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT category_classes_from_text(coalesce(p_term, '') || ' ' || coalesce(p_definition, ''));
$function$;
