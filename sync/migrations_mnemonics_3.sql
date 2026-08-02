-- ============================================================================
-- Mnemonic content corrections -- 2026-08-02
--
-- RC corrected two things after reviewing the batch:
-- 1. ALARM: the batch insert left this with breakdown=[] and a "not yet
--    confirmed" note (4 legible concepts read for 5 letters at insert time).
--    RC supplied the real 5th concept: "ALARM does have 5 words - Airspeed,
--    Landing spot, Air vents, Restart, Mayday." Matches A-L-A-R-M exactly.
-- 2. IMAIR: RC asked for the FAA's official "antidote" for each hazardous
--    attitude to be included (ex: Anti-authority's antidote is "follow the
--    rules, they are usually right"). Verified against FlyRegs' own AC 60-22
--    corpus text (Chapter 3, Figure 4 "THE FIVE ANTIDOTES") -- exact
--    verbatim table, not a paraphrase from a secondary source.
-- ============================================================================

update public.dictionary_terms
set senses = '[{
  "usage": null,
  "definition": "Engine-fire-during-flight response.",
  "breakdown": [
    {"letter": "A", "concept": "Airspeed", "detail": "increase, to help blow out the flames"},
    {"letter": "L", "concept": "Landing spot", "detail": "select immediately"},
    {"letter": "A", "concept": "Air vents", "detail": "close, to help starve the fire and limit smoke"},
    {"letter": "R", "concept": "Restart", "detail": "attempt per checklist, if time and altitude permit"},
    {"letter": "M", "concept": "Mayday", "detail": "declare the emergency"}
  ]
}]'::jsonb
where slug = 'mnem-alarm';

update public.dictionary_terms
set senses = '[{
  "usage": null,
  "definition": "Memory aid for the five FAA-recognized hazardous attitudes in aeronautical decision-making. Pairs with IMSAFE as a second \"IM\" ADM checklist -- an original FlyRegs mnemonic, not published by the FAA. Antidote wording is the FAA''s own, from AC 60-22 \"Figure 4. The Five Antidotes.\"",
  "breakdown": [
    {"letter": "I", "concept": "Impulsivity", "detail": "\"Do something quickly\" without stopping to think — Antidote: \"Not so fast. Think first.\""},
    {"letter": "M", "concept": "Macho", "detail": "\"I can do it, I''ll show them\" risk-taking to prove something — Antidote: \"Taking chances is foolish.\""},
    {"letter": "A", "concept": "Anti-authority", "detail": "\"Don''t tell me\" resistance to rules and instruction — Antidote: \"Follow the rules. They are usually right.\""},
    {"letter": "I", "concept": "Invulnerability", "detail": "\"It won''t happen to me\" — Antidote: \"It could happen to me.\""},
    {"letter": "R", "concept": "Resignation", "detail": "\"What''s the use?\" giving up control of the situation — Antidote: \"I''m not helpless. I can make a difference.\""}
  ]
}]'::jsonb
where slug = 'mnem-imair';
