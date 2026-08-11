-- RC, 2026-08-11: "23.2120 should be related to the question 'what are the
-- climb requirements for multi engine airplanes?'" Confirmed live: the
-- exact section title alone ("climb requirements") already ranks 23.2120
-- #1 with zero anchor needed -- pure lexical scoring gets that right. The
-- real gap is RC's actual phrasing: "climb requirements for multi engine
-- airplanes" drops 23.2120 to #7, behind six oxygen/engine-out sections
-- (121.331, 121.183, 121.181, 135.373, 135.371, 25.121) that just share
-- more raw "engine"/"requirements" keyword overlap. Also confirmed "twin
-- engine climb requirements" already works (23.2120 #1) -- pilots saying
-- "twin" instead of "multi" aren't affected, only the "multi engine"
-- phrasing specifically. Anchor matching is all-anchor-words-present,
-- any order (see search_anchor_matches) -- multiple short variants here
-- rather than one long compound phrase, matching the existing convention
-- (91.155 alone has 8).
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('multi engine climb', 'far', '23.2120', 'RC-reported gap: "climb requirements for multi engine airplanes" ranked 23.2120 #7 on raw lexical score, behind engine-out/oxygen sections sharing more keyword overlap'),
  ('multiengine climb requirements', 'far', '23.2120', 'one-word spelling variant matching the regulation''s own body text ("critical loss of thrust on multiengine")'),
  ('twin engine climb requirements', 'far', '23.2120', 'extra coverage alongside "multi engine" -- already ranked correctly unanchored, kept for consistency with the other phrasing anchors here'),
  ('climb gradient requirements', 'far', '23.2120', '23.2120''s own operative term ("a climb gradient of 8.3 percent...")');
