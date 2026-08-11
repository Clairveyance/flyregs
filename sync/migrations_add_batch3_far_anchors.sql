-- Third hand-crafted batch, final round of the Part 91/61/141/142 sweep.
-- 137.19 ("Certification requirements", agricultural aircraft operations)
-- has an unusually generic title that was outranking BOTH 141.5 and 142.5
-- on their own certification questions -- same shape as the earlier
-- 61.109/61.129 duplicate-title problem, different root (generic title
-- vs. literal duplicate title).
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('pilot school certification requirements', 'far', '141.5', '137.19 (agricultural aircraft "Certification requirements") outranked the actual pilot-school section on a pilot-school question -- pure keyword-density collision, unrelated topic'),
  ('requirements for a pilot school certificate', 'far', '141.5', NULL),
  ('training center certification requirements', 'far', '142.5', 'same 137.19 collision; 142.5 (certificate and training specifications required) never appeared in top 3'),
  ('seatbelt and shoulder harness requirements', 'far', '91.107', 'legitimate close call, not a clear miss -- 121.311 (Part 121 equivalent) and 91.521 (shoulder-harness-only) are both topically real and rank above the general Part 91 answer; light boost so the more commonly-relevant GA section (91.107) surfaces first for a bare Part 91 question')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
