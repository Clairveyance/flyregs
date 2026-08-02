-- Canonical single-word anchors  --  2026-07-31
--
-- The phrase anchors only fire when the whole phrase appears. Measured, real
-- questions rarely contain them: "do I need oxygen at 13000 feet" contains
-- neither "oxygen requirements" nor "when do i need oxygen", so § 91.211 sat
-- at #6 behind Part 121/135 oxygen sections that happened to share two title
-- words with the question.
--
-- For a handful of topics there IS one canonical section a pilot means, and
-- naming the topic at all is enough to say so. Kept deliberately short --
-- each of these is a word where the general-operating-rules answer is the
-- right default, and the regression cases in smartsearch_bench.py guard
-- against over-reach.
insert into public.search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('oxygen',          'far', '91.211', 'canonical topic word'),
  ('medical',         'far', '61.23',  'canonical topic word'),
  ('flight review',   'far', '61.56',  'canonical topic word'),
  ('hood',            'far', '91.109', 'simulated instrument flight'),
  ('simulated instrument', 'far', '91.109', null),
  ('view limiting device', 'far', '91.109', null),
  ('seat belt',       'far', '91.107', null),
  ('seat belts',      'far', '91.107', null),
  ('safety belt',     'far', '91.107', null),
  ('aerobatic',       'far', '91.303', null),
  ('aerobatics',      'far', '91.303', null),
  ('loops',           'far', '91.303', null),
  ('rolls',           'far', '91.303', null),
  ('too low',         'far', '91.119', null),
  ('how low',         'far', '91.119', null),
  ('low flying',      'far', '91.119', null),
  ('alternate airport', 'far', '91.169', null),
  ('ifr alternate',   'far', '91.169', null),
  ('required instruments', 'far', '91.205', null),
  ('instruments required', 'far', '91.205', null),
  ('vfr instruments', 'far', '91.205', null)
on conflict (phrase, doc_type, doc_id) do nothing;
