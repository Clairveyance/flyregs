-- Concept anchors for "TAA" (Technically Advanced Airplane), applied 2026-09-03.
--
-- RC reported this same gap before ("searching TAA for tech advanced a/c's")
-- and it was called fixed and wasn't. Root cause, confirmed by direct query
-- against the live search RPCs, not assumed:
--
-- search_far('TAA') on its own DOES correctly rank 61.1 and 61.129 #1 and #2
-- (out_rank 360/350, way ahead of #3). The SQL layer was never the problem
-- for the bare word. But natural phrasing degrades it badly -- word order
-- and vocabulary choice both matter to ts_rank:
--   'TAA aircraft requirements'          -> four generic "Aircraft
--       requirements"-titled sections (135.25, 137.31, ...) outrank 61.1/
--       61.129, because "aircraft requirements" as an adjacent phrase beats
--       one precise but lone hit on "TAA".
--   'technically advanced aircraft requirements' -> 61.1/61.129 drop behind
--       121.909 "Advanced Qualification Program" and an unrelated
--       powered-lift section, because "advanced"+"requirements" score
--       strongly elsewhere while the REGULATION'S OWN TERM is "technically
--       advanced AIRPLANE (TAA)" -- not "aircraft". RC named this exact
--       failure mode: "last time you told me it's not aircraft but
--       airplane... our system has to be way smarter than that."
--
-- Confirmed live: 61.1 has zero existing anchors, and 61.129's two anchors
-- (ids 172/173) are about "commercial pilot aeronautical experience"
-- phrasing, not TAA at all -- this was never actually curated before, only
-- reported and (wrongly) marked solved.
--
-- An anchor sidesteps ts_rank's phrasing sensitivity entirely: it adds
-- 2000+ to out_rank (see search_far's own scoring CTE) and sets
-- is_anchor=true, which the client (my-aircraft app/(tabs)/index.tsx)
-- floors at tier 0 unconditionally -- "the DB matched the QUESTION to the
-- document that answers it," ahead of any lexical tier. That is the SAME
-- mechanism 91.155 and 61.129's own existing anchors already rely on.
--
-- search_anchor_matches (see its own def) matches on EITHER a contiguous
-- phrase OR "every word of the anchor phrase appears in the query
-- somewhere" -- so 'technically advanced aircraft' as an anchor phrase
-- fires for "aircraft requirements for TAA... " style reorderings too, not
-- just the exact phrase. Both 'aircraft' and 'airplane' variants are added
-- deliberately, covering RC's own named vocabulary gap symmetrically rather
-- than requiring users to guess the FAA's exact word.
--
-- Both 61.1 (the actual DEFINITION: "Technically advanced airplane (TAA)
-- means an airplane equipped with an electronically advanced avionics
-- system") and 61.129 (the REQUIREMENT: TAA time credited toward commercial
-- aeronautical experience, paragraph (j)) get every phrase -- confirmed by
-- reading both sections' real body text first, not guessed.

insert into search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('taa', 'far', '61.1', 'Definition: "Technically advanced airplane (TAA) means an airplane equipped with an electronically advanced avionics system." RC-reported gap, 2026-09-03.'),
  ('taa', 'far', '61.129', 'TAA time counts toward commercial pilot aeronautical experience per paragraph (j). RC-reported gap, 2026-09-03.'),
  ('technically advanced aircraft', 'far', '61.1', 'Colloquial phrasing -- the reg itself says "airplane", not "aircraft"; anchored so users are not penalized for the word FAA does not use.'),
  ('technically advanced aircraft', 'far', '61.129', 'Colloquial phrasing -- the reg itself says "airplane", not "aircraft"; anchored so users are not penalized for the word FAA does not use.'),
  ('technically advanced airplane', 'far', '61.1', 'The FAA''s own exact term.'),
  ('technically advanced airplane', 'far', '61.129', 'The FAA''s own exact term.')
on conflict do nothing;

-- Follow-up, 2026-09-03: RC's own bug report, "class G airspace" found
-- nothing about Class G at all (Class D/B/C/A operating rules all outranked
-- it instead -- root cause was a search_anchor_matches bug, fixed
-- separately, see sync/migrations_search_ranking_general_fixes.sql). Class
-- A/B/C/D already each have their own FAR anchor to their own operating-
-- rules section; Class G never got one. Adding it now, mirroring that exact
-- existing pattern (confirmed 91.126 is the real "operating in Class G
-- airspace" section first, not guessed).
insert into search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('class g', 'far', '91.126', 'Mirrors the existing class a/b/c/d anchors -- Class G never got one. RC-reported gap, 2026-09-03.'),
  ('class golf', 'far', '91.126', 'Phonetic alphabet variant, same reasoning as class golf/bravo/charlie/delta already used elsewhere.')
on conflict do nothing;
