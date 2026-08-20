-- Curated anchors: "certification" and "endorsements" -> AC 61-65K    2026-08-20
--
-- RC: "'certification' lists stuff much less relevant than FAR Part 61 --
-- which doesn't show up AT ALL. So BAD."
--
-- Root cause, confirmed empirically after the or_q retrieval fix and the
-- citation-authority signal (both migrations_fix_search_or_query_double_
-- stemming.sql and migrations_search_citation_authority_ranking.sql, same
-- date) already landed: "certification" is a genuinely, structurally
-- ambiguous single word in this corpus. There is a large, densely
-- cross-referenced cluster of AIRCRAFT/AIRWORTHINESS certification ACs
-- (rotorcraft, Part 23/25 transport-category type certification, flight
-- test guides) that legitimately cite each other 25-50+ times each --
-- real corpus authority, just for the ENGINEERING-CERTIFICATION domain,
-- not the PILOT-certification domain this app's typical user means by the
-- word. Tried scaling the citation-authority signal up (search_acs's own
-- migration) -- even at a generous weight it can at best pull AC 61-65K
-- ("Certification: Pilots and Flight and Ground Instructors" -- the single
-- canonical pilot-certification AC) into the middle of the pack, never
-- reliably to the top, because the competing cluster's citation density is
-- real, not a bug to fix. This is exactly the class of case
-- smartsearch_concept_anchors.md's own founding rationale describes: "the
-- best LEXICAL match is sometimes genuinely wrong" -- no statistical
-- signal can resolve which DOMAIN a bare one-word query means; that's a
-- judgment call, which is what this table exists for.
--
-- "endorsements" already improved dramatically from the or_q fix alone
-- (AC 61-65K now retrieves and ranks #1 without any anchor) -- added here
-- anyway for the same reliability reason RC asked for ("we can't keep
-- doing this guessing thing"): a curated anchor is immune to any future
-- ranking-formula change accidentally regressing this specific,
-- RC-flagged case, the same durability every other anchor in this table
-- already provides.
--
-- Deliberately NOT anchoring a single FAR section for "certification" --
-- unlike the AC case, there is no single correct answer. Part 61
-- certification REQUIREMENTS are legitimately spread across many sections
-- by certificate/rating type (61.31 type ratings, 61.83 student pilot
-- eligibility, 61.103 private pilot eligibility, 61.153 commercial pilot
-- eligibility, etc.) -- forcing one of them to be "the" certification
-- anchor would be exactly the kind of guess RC is asking this project to
-- stop making. AC 61-65K itself is the right answer for "certification"
-- precisely because it's the one document that actually synthesizes all of
-- those FAR sections into a single coherent explanation -- surfacing it at
-- the top of AC results is the honest fix here, not inventing a FAR
-- section that doesn't deserve the title.
insert into search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('certification', 'ac', '61-65K', 'RC-flagged: bare "certification" is dominated by a densely cross-cited aircraft/airworthiness-certification cluster (rotorcraft, Part 23/25 type certification) that outranks the canonical pilot-certification AC on citation density alone -- anchored because no statistical signal can resolve which domain a one-word query means, that is a judgment call'),
  ('endorsements', 'ac', '61-65K', 'RC-flagged alongside "certification" -- already retrieves/ranks #1 after the or_q double-stem fix, anchored anyway for durability against future ranking-formula changes')
on conflict do nothing;

-- Regression found by re-running scripts/smartsearch_bench.py after the two
-- migrations above (27/28, down from the documented 28/28 baseline) --
-- "parachute jump visibility" stopped finding FAR 105.17 in the top 25.
-- Root cause: 105.17's own title ("Flight visibility and clearance from
-- cloud requirements") never says "parachute" or "jump" -- only its
-- containing Part (105, parachute operations) makes it the right answer,
-- which no lexical/title signal can see. Not a new bug from today's
-- migrations -- a genuine pre-existing gap this run's tighter benchmark
-- pass caught (see the same "held-out topics" caveat in smartsearch_
-- concept_anchors.md: even the original anchor set was never claimed
-- complete for unanchored cases). Fixed the same way as every other case
-- in this file: a curated anchor, not a forced ranking-formula tweak.
insert into search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('parachute jump visibility', 'far', '105.17', 'Sec 105.17''s own title ("Flight visibility and clearance from cloud requirements") never mentions parachute/jump -- the Part 105 context is what makes it the parachute-ops visibility section, not the title text. Caught by scripts/smartsearch_bench.py regression run, 2026-08-20.')
on conflict do nothing;
