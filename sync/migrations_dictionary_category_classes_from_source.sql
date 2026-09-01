-- Tag category-specific dictionary terms to their aircraft category (2026-09-01)
--
-- RC: "there are a lot of filter options for study and duels. make sure they
-- actually do their jobs when selected."
--
-- The Category/Class filter was doing almost nothing for the Dictionary: 140
-- Helicopter Flying Handbook terms and 126 Glider Flying Handbook terms were
-- ALL untagged, because dictionary_category_classes fell through to
-- category_classes_from_text(term) -- keyword matching on the term NAME, which
-- tagged 14 terms corpus-wide. "Blade loading" (Helicopter Flying Handbook)
-- therefore surfaced for a student filtering to ASEL.
--
-- The handbook a term came from is the honest category signal, same as
-- migrations_populate_dictionary_levels.sql uses it for knowledge level.
--
-- CONSERVATIVE ON PURPOSE: a NULL here means "applies to every category", and
-- that is the right default for the vast majority of aviation vocabulary. Only
-- the three unambiguously category-specific handbooks are tagged. The Airplane
-- Flying Handbook is deliberately NOT tagged to the airplane classes -- most of
-- its glossary (aerodynamics, weather, systems) applies to a glider or
-- helicopter pilot too, and tagging it would hide that content the moment
-- someone filtered to GLIDER.
--
-- A term citing a category-specific handbook AND a general one (PHAK, AFH,
-- contractions, NWS) stays NULL: appearing in both means it is general
-- vocabulary that the specialty handbook also happens to define.

begin;

create or replace function public.dictionary_category_classes(p_slug text)
returns text[]
language sql
stable
as $function$
  select case
    when exists (
      select 1 from dictionary_terms
      where slug = p_slug and category = 'mnemonic' and mnemonic_group = 'Multi-Engine Operations'
    ) then array['AMEL', 'AMES']
    when exists (
      select 1 from dictionary_terms d
      where d.slug = p_slug
        and (d.source like '%8083-21%' or d.source like '%8083-13%' or d.source like '%8083-23%')
        -- ...but not if a general-audience source also defines it.
        and d.source not like '%8083-25%'
        and d.source not like '%8083-3C%'
        and d.source not like '%JO 7340%'
        and d.source not like '%NOAA%'
        and d.source not like '%National Weather Service%'
    ) then (
      select array(select distinct unnest(
             (case when d.source like '%8083-21%' then array['HELI']          else '{}'::text[] end)
           ||(case when d.source like '%8083-13%' then array['GLIDER']        else '{}'::text[] end)
           ||(case when d.source like '%8083-23%' then array['ASES','AMES','HELI'] else '{}'::text[] end)
      ) order by 1)
      from dictionary_terms d where d.slug = p_slug
    )
    else category_classes_from_text((select term from dictionary_terms where slug = p_slug))
  end;
$function$;

commit;
