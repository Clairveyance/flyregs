-- ============================================================================
-- Mnemonic fixes round 3 -- 2026-08-02
--
-- PAVE bug fix: the previous elaboration pass (migrations_mnemonics_5.sql)
-- targeted slug 'mnem-pave', which doesn't exist -- PAVE was reclassified
-- from a pre-existing dictionary_terms row before the mnemonic_group
-- column existed (same as IMSAFE), so its real slug is
-- 'rm_glossary-pave'. The PATCH silently matched zero rows (a filter that
-- matches nothing still returns success) and this went uncaught until RC
-- checked the live app and found PAVE still bare. Re-verified every OTHER
-- slug from that same pass against the live DB before writing this --
-- PAVE was the only miss.
--
-- CRAFT: RC asked for this explicitly, elaborated with his own supplied
-- breakdown, and called out that it's the more commonly used clearance
-- mnemonic, distinct from NW KRAFT (a completely different mnemonic --
-- NW KRAFT is what a pilot briefs before flight, CRAFT is what ATC reads
-- back as the clearance).
--
-- HAT MAP: added on RC's own direct knowledge (not independently found in
-- general web search, unlike verified entries elsewhere in this
-- compendium) -- flagged clearly in its own definition that "HAT" already
-- means something else and unrelated (Height Above Touchdown, a real
-- published approach-chart value) so the two don't get confused.
-- ============================================================================

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Memory aid for the four risk-identification areas used in preflight risk assessment.",
  "breakdown": [
    {"letter": "P", "concept": "Pilot", "detail": "the pilot''s own fitness to fly -- see IMSAFE"},
    {"letter": "A", "concept": "Aircraft", "detail": "the aircraft''s airworthiness and performance capability for this specific flight"},
    {"letter": "V", "concept": "enVironment", "detail": "weather, terrain, airport, and airspace conditions"},
    {"letter": "E", "concept": "External pressures", "detail": "\"get-there-itis,\" schedules, passengers, or other pressure to fly as planned regardless of risk"}
  ]
}]'::jsonb where slug = 'rm_glossary-pave';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "The elements ATC includes in an IFR clearance delivery -- the more commonly used moniker for this than NW KRAFT (a completely different mnemonic: NW KRAFT is what YOU brief before the flight; CRAFT is what ATC reads back to you as your clearance).",
  "breakdown": [
    {"letter": "C", "concept": "Clearance limit", "detail": "the fix/airport your clearance is valid to -- usually destination, sometimes short of it"},
    {"letter": "R", "concept": "Route", "detail": "the routing, including any departure procedure"},
    {"letter": "A", "concept": "Altitude", "detail": "initial altitude to expect, and when to expect further climb"},
    {"letter": "F", "concept": "Frequency", "detail": "departure frequency to contact after takeoff"},
    {"letter": "T", "concept": "Transponder code", "detail": ""}
  ]
}]'::jsonb where slug = 'mnem-craft';

insert into public.dictionary_terms (term, slug, letter, category, mnemonic_group, senses, source)
select 'HAT MAP', 'mnem-hat-map', 'H', 'mnemonic', 'Approaches & Transitions',
  '[{
    "usage": null,
    "definition": "Common approach-briefing setup items. Not to be confused with HAT -- Height Above Touchdown, the published altitude value on approach charts -- a completely different, official term that happens to share this mnemonic''s first component.",
    "breakdown": [
      {"letter": "H", "concept": "Heading", "detail": "the final approach course, or first heading after the missed approach point"},
      {"letter": "A", "concept": "Altitude", "detail": "minimums -- DA/DH or MDA -- and any step-down altitudes along the approach"},
      {"letter": "T", "concept": "Time", "detail": "if timed from the final approach fix (needed for non-precision approaches without DME/GPS)"},
      {"letter": "MAP", "concept": "Missed Approach Point", "detail": "where it is, and the missed approach procedure to fly from it"}
    ]
  }]'::jsonb,
  'General aviation flight-training mnemonic (widely taught, not FAA-published verbatim) -- not independently found in general web search, added on RC''s own direct knowledge'
where not exists (select 1 from public.dictionary_terms where slug = 'mnem-hat-map');
