-- RC: "we need another full hunt for more Mn. Today i learned of more Mn
-- for multi engine. like COMBATS, SMACFUM, and PAST. make sure these are
-- in there, and look for more." All 3 confirmed absent from
-- dictionary_terms (category='mnemonic', 49 rows, zero in a multi-engine
-- topic at all before this). Each verified against 2 independent sources
-- before adding (personalwings.com, melibrary.pro for PAST/COMBATS;
-- atairaerospace.com, inflightkam.com for SMACFUM) -- both sources agreed
-- exactly on every letter for all 3, no discrepancies to reconcile.
--
-- COMBATS and SMACFUM are two DIFFERENT mnemonics for the SAME underlying
-- content (the 7 FAA-standardized conditions for demonstrating Vmc, minimum
-- controllable airspeed, per 14 CFR 23.149/25.149) -- different schools
-- teach different letter orderings for the identical 7 factors. Cross-
-- linked via see_also_slug so a reader who knows one form can find the
-- other, rather than treating them as unrelated.
--
-- Searched further for other standalone multi-engine LETTER-mnemonics
-- (not just these 3) -- Wikipedia's aviation mnemonics list, defineaviation.info's
-- dedicated multi-engine page, and 3 more targeted searches found nothing
-- else in this specific corpus's format (a spelled acronym with a
-- letter-by-letter breakdown). Did find 2 non-acronym TEACHING PHRASES
-- ("dead foot, dead engine" for identifying the failed engine; "raise the
-- dead" for prop/gear cleanup after identifying it) -- deliberately not
-- added here since they don't fit this table's letter-breakdown format
-- (every existing row spells an actual word/phrase from its own letters);
-- flagged to RC as a possible future "teaching phrases" content type
-- rather than force-fit into the wrong shape.
INSERT INTO dictionary_terms (slug, term, letter, category, senses, source, mnemonic_group, see_also_slug) VALUES
  ('mnem-past', 'PAST', 'P', 'mnemonic',
   '[{"usage": null, "breakdown": [
       {"letter": "P", "concept": "P-factor", "detail": "asymmetric thrust of the descending propeller blade at high power/high AOA"},
       {"letter": "A", "concept": "Accelerated slipstream", "detail": "operating engine''s prop wash increases lift on that wing"},
       {"letter": "S", "concept": "Spiraling slipstream", "detail": "helical airflow from the operating engine''s propeller striking the vertical stabilizer"},
       {"letter": "T", "concept": "Torque", "detail": "Newton''s third law reaction rolling the aircraft opposite the propeller''s rotation"}
     ],
     "definition": "The 4 aerodynamic factors that make a multi-engine airplane roll/yaw toward the dead engine when the critical engine fails. Pilots usually ask: why does losing an engine cause a twin to roll toward it, or what is the critical engine and why."}]'::jsonb,
   'Standard multi-engine flight-training mnemonic (widely taught, not FAA-published verbatim)',
   'Multi-Engine Operations', NULL),

  ('mnem-combats', 'COMBATS', 'C', 'mnemonic',
   '[{"usage": null, "breakdown": [
       {"letter": "C", "concept": "Critical engine inoperative and windmilling", "detail": ""},
       {"letter": "O", "concept": "Operating engine at full power", "detail": ""},
       {"letter": "M", "concept": "Maximum unfavorable weight", "detail": "lightest allowable weight"},
       {"letter": "B", "concept": "Bank into the operating engine", "detail": "up to 5 degrees"},
       {"letter": "A", "concept": "Aft-most center of gravity", "detail": ""},
       {"letter": "T", "concept": "Takeoff configuration", "detail": "flaps/gear as specified for takeoff"},
       {"letter": "S", "concept": "Standard temperature", "detail": "standard day, sea level"}
     ],
     "definition": "The 7 worst-case conditions the FAA requires a manufacturer to demonstrate under when establishing a multi-engine airplane''s published Vmc (14 CFR 23.149/25.149). Pilots usually ask: what conditions is Vmc tested under, or why can the airplane actually lose control below published Vmc in a different configuration. Same underlying 7 factors as SMACFUM, different letter order/mnemonic."}]'::jsonb,
   'Standard multi-engine flight-training mnemonic (widely taught, not FAA-published verbatim)',
   'Multi-Engine Operations', 'mnem-smacfum'),

  ('mnem-smacfum', 'SMACFUM', 'S', 'mnemonic',
   '[{"usage": null, "breakdown": [
       {"letter": "S", "concept": "Standard day", "detail": "29.92 in. Hg, 15°C, sea level"},
       {"letter": "M", "concept": "Max power", "detail": "on the operating engine"},
       {"letter": "A", "concept": "Aft CG", "detail": "greatest allowable aft center of gravity"},
       {"letter": "C", "concept": "Critical engine windmilling", "detail": "inoperative, propeller windmilling (not feathered)"},
       {"letter": "F", "concept": "Flaps/gear", "detail": "takeoff configuration, gear up"},
       {"letter": "U", "concept": "Up to 5° bank", "detail": "into the operating engine"},
       {"letter": "M", "concept": "Most unfavorable weight", "detail": "lightest allowable weight"}
     ],
     "definition": "The same 7 FAA-standardized Vmc demonstration conditions as COMBATS (14 CFR 23.149/25.149), taught with a different letter grouping. Pilots usually ask: what does SMACFUM stand for, or Vmc demonstration conditions."}]'::jsonb,
   'Standard multi-engine flight-training mnemonic (widely taught, not FAA-published verbatim)',
   'Multi-Engine Operations', 'mnem-combats')
ON CONFLICT (slug) DO NOTHING;
