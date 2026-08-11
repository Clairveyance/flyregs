-- Second hand-crafted batch, same investigation as
-- migrations_add_23_2120_climb_anchors.sql. 61.109 and 61.129 share the
-- EXACT same title ("Aeronautical experience" -- one is the private pilot
-- version, one commercial) -- anchor phrases here deliberately include
-- "private"/"commercial" so search_anchor_matches' all-words-present rule
-- can't collide the two.
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('too close to another aircraft', 'far', '91.111', 'was returning civil-penalty admin sections (13.16/13.18) and an AD-related section, matched purely on the word "penalty" -- 91.111 itself never surfaced'),
  ('operating near other aircraft', 'far', '91.111', NULL),
  ('private pilot cross country time', 'far', '61.109', 'complete noise before this: top 5 were all obscure Part 194 powered-lift-category sections, the actual private pilot aeronautical experience section never appeared'),
  ('private pilot aeronautical experience', 'far', '61.109', NULL),
  ('commercial pilot aeronautical experience', 'far', '61.129', 'same Part 194 noise problem as 61.109 above -- these two share an identical section title ("Aeronautical experience"), phrase must include private/commercial to disambiguate'),
  ('commercial pilot flight experience requirements', 'far', '61.129', NULL),
  ('light sport aircraft maximum weight', 'far', '1.1', 'LSA weight limit is defined within the general definitions section -- specific enough as an anchor phrase despite 1.1 itself covering many unrelated terms')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
