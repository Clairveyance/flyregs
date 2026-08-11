-- The 2 new substantive terms just added (migrations_pcg_official_sweep.sql)
-- both lost badly to a DIFFERENT term on their own exact name as a query --
-- "temporary flight restriction" ranked SPECIAL ACTIVITY AIRSPACE (SAA)
-- #1 (score ~1000) and the real TFR entry #2 (score ~1.0); same shape for
-- "takeoff roll" vs PREDICTIVE WIND SHEAR ALERT SYSTEM (PWS). Root cause:
-- the other term's own definition happens to contain the exact query
-- phrase as a literal substring, and the substring-ratio scoring term
-- rewards that heavily regardless of which entry the phrase is actually
-- ABOUT. Same shape as every other anchor in this corpus -- not a retrieval
-- failure (both were found, just outranked).
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('temporary flight restriction', 'pcg', 'TEMPORARY_FLIGHT_RESTRICTION_TFR', 'lost to SPECIAL ACTIVITY AIRSPACE (SAA) on its own exact name -- SAA''s definition happens to mention the phrase, dominating via substring-ratio scoring'),
  ('tfr', 'pcg', 'TEMPORARY_FLIGHT_RESTRICTION_TFR', NULL),
  ('takeoff roll', 'pcg', 'TAKEOFF_ROLL', 'lost to PREDICTIVE WIND SHEAR ALERT SYSTEM (PWS) on its own exact name for the same reason')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
