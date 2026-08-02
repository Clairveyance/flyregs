-- ============================================================================
-- Mnemonic elaboration pass -- 2026-08-02
--
-- RC: "COPS doesn't adequately explain what it does... we need to do this
-- for several of the Mn. go through them and see which ones need some
-- elaboration." A systematic read-through found CARE, DECIDE, TEAM,
-- IMSAFE, and PAVE were ALSO completely bare (zero detail on every single
-- item) -- including two of the most foundational, widely-taught
-- mnemonics in the whole set. ICEFLAGS' eight illusions were bare too and
-- genuinely unfamiliar-sounding without a definition. All elaborated here,
-- each verified against real sources (DECIDE and the ICEFLAGS illusions
-- both checked against FAA/CFI-training material, not written from
-- memory alone).
--
-- COPS: two independent searches (Wikipedia's dedicated aviation-
-- mnemonics list, and general web search) found no trace of "COPS" as a
-- real, established mnemonic -- unlike every other entry here, which is
-- independently verifiable. Rather than invent a "clearer" explanation
-- for content that might not be real, this is left with an explicit
-- in-app flag asking RC to confirm the original source, instead of
-- silently compounding a possible error.
--
-- UNOS: separately, RC asked whether this describes compass lead/lag --
-- confirmed yes (Undershoot North = lead the compass, Overshoot South =
-- lag the compass), and rewrote using that action-based framing per RC's
-- own suggested phrasing.
-- ============================================================================

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Memory aid for managing risk during flight.",
  "breakdown": [
    {"letter": "C", "concept": "Consequences", "detail": "what''s the worst realistic outcome if this risk goes unmanaged?"},
    {"letter": "A", "concept": "Alternatives", "detail": "what other options exist besides continuing the current plan?"},
    {"letter": "R", "concept": "Reality", "detail": "is the situation really as safe as it looks, or are you rationalizing?"},
    {"letter": "E", "concept": "External Factors", "detail": "pressures -- schedule, passengers, cost -- that could be biasing the decision"}
  ]
}]'::jsonb where slug = 'mnem-care';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Six-step aeronautical decision-making model.",
  "breakdown": [
    {"letter": "D", "concept": "Detect", "detail": "notice that a change has occurred or a problem exists"},
    {"letter": "E", "concept": "Estimate", "detail": "estimate how significant that change is to the flight"},
    {"letter": "C", "concept": "Choose", "detail": "choose a safe outcome for the flight"},
    {"letter": "I", "concept": "Identify", "detail": "identify actions that could achieve that outcome"},
    {"letter": "D", "concept": "Do", "detail": "take the best action"},
    {"letter": "E", "concept": "Evaluate", "detail": "evaluate the effect of that action, and repeat the process as needed"}
  ]
}]'::jsonb where slug = 'mnem-decide';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Memory aid for risk mitigation strategies.",
  "breakdown": [
    {"letter": "T", "concept": "Transfer", "detail": "shift the risk to someone else -- a CFI, ATC, or another pilot/service"},
    {"letter": "E", "concept": "Eliminate", "detail": "remove the risk entirely, e.g. don''t fly in that weather at all"},
    {"letter": "A", "concept": "Accept", "detail": "knowingly proceed because the risk is understood and manageable"},
    {"letter": "M", "concept": "Mitigate", "detail": "reduce the risk''s likelihood or severity, e.g. extra fuel, a higher personal minimum"}
  ]
}]'::jsonb where slug = 'mnem-team';

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
  "definition": "Memory aid for the six aeromedical risk areas used in personal fitness self-assessment before flight.",
  "breakdown": [
    {"letter": "I", "concept": "Illness", "detail": "any symptoms that could affect flight safety?"},
    {"letter": "M", "concept": "Medication", "detail": "any prescription or over-the-counter drug that could impair performance?"},
    {"letter": "S", "concept": "Stress", "detail": "psychological or emotional stress that could distract from flying?"},
    {"letter": "A", "concept": "Alcohol", "detail": "FAR 91.17 -- 8 hours \"bottle to throttle,\" 0.04 BAC limit"},
    {"letter": "F", "concept": "Fatigue", "detail": "adequately rested before this flight?"},
    {"letter": "E", "concept": "Emotion", "detail": "emotionally fit to make sound decisions right now?"}
  ]
}]'::jsonb where slug = 'rm_glossary-imsafe';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Vestibular (inner-ear) and visual illusions that cause spatial disorientation.",
  "breakdown": [
    {"letter": "I", "concept": "Inversion illusion", "detail": "an abrupt return to level flight after a climb feels like tumbling backward"},
    {"letter": "C", "concept": "Coriolis illusion", "detail": "an abrupt head movement during a prolonged turn creates a sensation of rotating on a different axis"},
    {"letter": "E", "concept": "Elevator illusion", "detail": "an abrupt updraft or downdraft creates a false sensation of climbing or descending"},
    {"letter": "F", "concept": "False horizon", "detail": "sloping clouds or terrain lighting are mistaken for the real horizon"},
    {"letter": "L", "concept": "Leans", "detail": "a sudden return to level flight after a gradual, unfelt turn creates a false sensation of banking the other way"},
    {"letter": "A", "concept": "Autokinesis", "detail": "a stationary light stared at in the dark appears to move"},
    {"letter": "G", "concept": "Graveyard spin/spiral", "detail": "the inner ear stops sensing a prolonged turn; pulling up to \"level off\" while still banked can tighten the spiral instead of correcting it"},
    {"letter": "S", "concept": "Somatogravic illusion", "detail": "rapid acceleration (e.g. takeoff) feels like pitching nose-up, tempting a dangerous nose-down correction"}
  ]
}]'::jsonb where slug = 'mnem-iceflags';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "NOT YET VERIFIED as a real, standard mnemonic -- two independent searches (Wikipedia''s dedicated aviation-mnemonics list, and general web search) found no trace of \"COPS\" as an established compass-error mnemonic, unlike every other entry in this compendium. The breakdown below is what was originally transcribed, but should be confirmed against a real source (or removed) rather than trusted as-is.",
  "breakdown": [
    {"letter": "C", "concept": "Climb", "detail": ""},
    {"letter": "O", "concept": "Overshoot", "detail": "compass reads a turn during a climb"},
    {"letter": "P", "concept": "Pitch", "detail": ""},
    {"letter": "S", "concept": "South", "detail": "or reverse, depending on hemisphere/heading"}
  ]
}]'::jsonb where slug = 'mnem-cops';

update public.dictionary_terms set senses = '[{
  "usage": null,
  "definition": "Magnetic compass turning errors during a standard-rate turn (Northern Hemisphere) -- when rolling out of a turn, lead the compass (roll out early) on a Northerly heading, lag the compass (roll out late) on a Southerly heading, by roughly your latitude in degrees.",
  "breakdown": [
    {"letter": "U", "concept": "Undershoot", "detail": "turning to a Northerly heading -- lead the compass: roll out BEFORE reaching North"},
    {"letter": "N", "concept": "North", "detail": ""},
    {"letter": "O", "concept": "Overshoot", "detail": "turning to a Southerly heading -- lag the compass: continue turning PAST South before rolling out"},
    {"letter": "S", "concept": "South", "detail": ""}
  ]
}]'::jsonb where slug = 'mnem-unos';
