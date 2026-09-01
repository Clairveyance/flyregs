-- File the Aviation Dictionary into the study/duel filter boxes (2026-09-01)
--
-- RC: "can you properly include the dict items into the filters and Q bank?
-- they should be available, as long as they can be filtered correctly"
--
-- Dictionary is the single largest corpus in the bank (6,387 playable items,
-- more than FAR's 3,453) but dictionary_term_levels has been EMPTY since
-- migrations_dictionary_quiz_integration.sql created it, and the corpus-wide
-- convention is "unclassified = excluded from any ACTIVE level filter". So
-- every dictionary item vanished the moment a user tapped ANY level chip --
-- proven live: get_study_pool_count(p_levels=>'{private}') counts 0 dictionary
-- rows against 6,387 unfiltered.
--
-- That migration deferred this to "an LLM tags a level per term in a LATER,
-- costed authoring pass". It turns out no such pass is needed: every term
-- already carries a `source` naming the FAA handbook it came from, and the
-- handbook IS the level signal. FAA-H-8083-31B is the Airframe AMT handbook;
-- FAA-H-8083-21 is the Helicopter Flying Handbook. Deterministic, auditable,
-- and free.
--
-- Sources are compound and semicolon-joined ("...8083-15B...; ...8083-25C..."),
-- so matching on the handbook CODE as a substring gives a term citing two
-- handbooks both sets of levels, which is the correct behaviour.
--
-- CODE-PREFIX HAZARD, deliberately handled: '8083-3' is a prefix of '8083-30',
-- '8083-31' and '8083-32' -- matching it loosely would file all three
-- MAINTENANCE handbooks as the Airplane Flying Handbook. Same trap for
-- '8083-2' ('8083-21/23/25/28/29') and '8083-1' ('8083-13/15/16/17'). The
-- exact revision suffixes below ('8083-3C', '8083-2A', '8083-1B') avoid it.

begin;

delete from public.dictionary_term_levels;

insert into public.dictionary_term_levels (slug, levels)
select d.slug, array(select distinct unnest(lv) order by 1)
from (
  select d.slug,
    (case when d.source like '%8083-25%' then array['student','private','commercial','atp','cfi'] else '{}'::text[] end)
  ||(case when d.source like '%8083-3C%' then array['student','private','commercial','cfi']       else '{}'::text[] end)
  ||(case when d.source like '%8083-21%' then array['student','private','commercial','cfi']       else '{}'::text[] end)
  ||(case when d.source like '%8083-13%' then array['student','private','commercial','cfi']       else '{}'::text[] end)
  ||(case when d.source like '%8083-23%' then array['private','commercial','cfi']                 else '{}'::text[] end)
  ||(case when d.source like '%8083-15%' then array['instrument','commercial','atp','cfi']        else '{}'::text[] end)
  ||(case when d.source like '%8083-16%' then array['instrument','commercial','atp','cfi']        else '{}'::text[] end)
  ||(case when d.source like '%8083-31%' then array['mechanic','airframe']                        else '{}'::text[] end)
  ||(case when d.source like '%8083-32%' then array['mechanic','powerplant']                      else '{}'::text[] end)
  ||(case when d.source like '%8083-30%' then array['mechanic','airframe','powerplant']           else '{}'::text[] end)
  ||(case when d.source like '%8083-17%' then array['mechanic']                                   else '{}'::text[] end)
  ||(case when d.source like '%8083-29%' then array['student','private']                          else '{}'::text[] end)
  ||(case when d.source like '%8083-9%'  then array['cfi']                                        else '{}'::text[] end)
  ||(case when d.source like '%8083-2A%' then array['private','commercial','atp','cfi']           else '{}'::text[] end)
  ||(case when d.source like '%8083-1B%' then array['private','commercial','mechanic']            else '{}'::text[] end)
  ||(case when d.source like '%8083-28%' then array['student','private','commercial','atp','cfi','instrument'] else '{}'::text[] end)
  -- ATC contractions (3,282 terms) and the NWS weather glossary (2,113) are
  -- not tied to any one certificate -- every pilot reads both on every flight.
  ||(case when d.source like '%JO 7340%' then array['student','private','commercial','atp','cfi','instrument'] else '{}'::text[] end)
  ||(case when d.source like '%NOAA%' or d.source like '%National Weather Service%'
          then array['student','private','commercial','atp','cfi','instrument'] else '{}'::text[] end)
  ||(case when d.source like '%ICAO phonetic%' then array['student','private','commercial','atp','cfi'] else '{}'::text[] end)
  -- One row carries a raw filename instead of a handbook string
  -- ('amt_airframe_glossary.txt'). Data wart in dictionary_terms.source, not
  -- a mapping gap -- caught because this migration verifies full coverage.
  ||(case when d.source like '%amt_airframe%' then array['mechanic','airframe'] else '{}'::text[] end)
  ||(case when d.category in ('mnemonic','informal') then array['student','private','commercial','cfi'] else '{}'::text[] end)
    as lv
  from public.dictionary_terms d
) d
where array_length(lv, 1) > 0;

commit;
