-- RC: "let's get after that P/CG extraction and make sure we have them
-- ALL. it must be complete." Closes the 5 items left unresolved in the
-- first pass (migrations_pcg_official_sweep.sql), using BeautifulSoup for
-- reliable parsing this time instead of regex against raw HTML text --
-- the earlier id-based lookup failed for TODA/TORA/TVOR because their
-- entries don't use the same <p id="..."> wrapper pattern as most others;
-- switched to full-document text search to locate them directly instead.
--
-- Resolution for all 5:
--  - TODA, TORA, TVOR: genuine standalone official definitions, no
--    coverage anywhere in ours. Added verbatim.
--  - SATELLITE: confirmed NOT a real official entry at all -- the
--    original diff's "SATELLITE" name was a mis-parse artifact (matched
--    partway into "...SEARCH AND RESCUE SATELLITE..." and "SATELLITE-
--    BASED AUGMENTATION SYSTEM (SBAS)", not a standalone heading).
--    Verified via regex requiring "SATELLITE" followed immediately by a
--    dash (the entry-boundary marker) -- zero matches. Not a gap; no
--    action.
--  - TRAFFIC INFORMATION: real official entry, but a redirect stub
--    ("TRAFFIC INFORMATION - See TRAFFIC ADVISORIES"), and we already
--    have TRAFFIC_ADVISORIES. Anchor only, not a new row.
--
-- With this migration, every one of the original 32 "official has it, we
-- don't" names is resolved: 10 new terms total across both sweep passes,
-- 12 anchors, 8 needed nothing (abbreviation already embedded in an
-- existing term's own name/parenthetical, findable via plain lexical
-- search), 1 was never a real gap.
INSERT INTO pcg_terms (slug, term, letter, definition) VALUES
  ('TAKEOFF_DISTANCE_AVAILABLE_TODA', 'TAKEOFF DISTANCE AVAILABLE (TODA)', 'T',
   'The takeoff run available plus the length of any remaining runway or clearway beyond the far end of the takeoff run available.'),
  ('TAKEOFF_RUN_AVAILABLE_TORA', 'TAKEOFF RUN AVAILABLE (TORA)', 'T',
   'The runway length declared available and suitable for the ground run of an airplane taking off.'),
  ('TERMINAL_VHF_OMNIDIRECTIONAL_RANGE_STATION_TVOR', 'TERMINAL-VERY HIGH FREQUENCY OMNIDIRECTIONAL RANGE STATION (TVOR)', 'T',
   'A very high frequency terminal omnirange station located on or near an airport and used as an approach aid.')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('toda', 'pcg', 'TAKEOFF_DISTANCE_AVAILABLE_TODA', NULL),
  ('tora', 'pcg', 'TAKEOFF_RUN_AVAILABLE_TORA', NULL),
  ('tvor', 'pcg', 'TERMINAL_VHF_OMNIDIRECTIONAL_RANGE_STATION_TVOR', NULL),
  ('traffic information', 'pcg', 'TRAFFIC_ADVISORIES', 'official glossary treats "traffic information" as a redirect to TRAFFIC ADVISORIES'),
  -- found via live verification after the above applied: the bare full
  -- name "takeoff run available" lost to TAKEOFF DISTANCE AVAILABLE
  -- (TODA) on shared "takeoff"/"available" words, same collision shape
  -- as every other new-term-vs-existing-term case this session
  ('takeoff run available', 'pcg', 'TAKEOFF_RUN_AVAILABLE_TORA', 'collided with TAKEOFF DISTANCE AVAILABLE (TODA) on shared takeoff/available words')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
