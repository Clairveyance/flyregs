-- Found while following up on RC's 23.2120 report with more hand-picked
-- "how a pilot actually asks it" questions, per the ask for a corpus-wide
-- sweep -- these are 3 more confirmed real gaps, same failure shape
-- (generic-sounding section title means the section never surfaces for a
-- specific natural-language question, even though it's the textbook
-- answer). All verified live before and after.
--
-- 91.205 ("Instrument and equipment requirements") did not appear in the
-- top 5 at all for "what is the minimum equipment for night VFR flight?"
-- -- arguably one of the single most commonly searched sections in all of
-- general aviation training (the VFR equipment list, "TOMATO FLAMES").
-- Top result instead was 91.155 (VFR weather MINIMUMS -- wrong concept,
-- matched on the word "minimum").
--
-- 61.31 ("Type rating requirements, additional training, and
-- authorization requirements") covers BOTH the complex-airplane
-- endorsement (61.31(e)) and high-performance endorsement (61.31(f)) --
-- two of the most commonly asked checkride-prep questions -- but its own
-- title says neither "complex" nor "high performance", so it never
-- surfaced for either question. Confirmed both independently missing from
-- top 5.
-- ON CONFLICT DO NOTHING: 91.205 already had partial coverage (day-
-- equipment and general "instruments required" phrasings, discovered when
-- the first version of this migration hit a duplicate-key error on
-- "required instruments vfr") -- none of the existing ones covered NIGHT
-- specifically, which is the actual gap. Idempotent/re-runnable rather
-- than hand-auditing every row against what might already exist.
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('minimum equipment night vfr', 'far', '91.205', 'RC-reported-style gap: not in top 5 for "minimum equipment for night VFR flight" -- top result was 91.155 (VFR weather minimums, wrong concept)'),
  ('vfr equipment requirements', 'far', '91.205', NULL),
  ('day vfr equipment requirements', 'far', '91.205', NULL),
  ('night vfr equipment requirements', 'far', '91.205', NULL),
  ('required instruments vfr', 'far', '91.205', NULL),
  ('complex airplane requirements', 'far', '61.31', 'complex-airplane endorsement is 61.31(e), but the section title says neither "complex" nor "endorsement" -- never surfaced for this question'),
  ('complex airplane endorsement', 'far', '61.31', NULL),
  ('high performance airplane requirements', 'far', '61.31', 'high-performance endorsement is 61.31(f), same gap as complex above'),
  ('high performance endorsement', 'far', '61.31', NULL)
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
