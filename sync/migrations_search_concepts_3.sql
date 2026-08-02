-- Cockpit shorthand anchors  --  2026-07-31
--
-- "vfr mins" left § 91.155 at #6. The anchors held "vfr minimums" but the
-- pilot wrote "mins", and short words are deliberately NOT autocorrected
-- (see search_resolve_term: a 4-letter word has too few letters for a fuzzy
-- rewrite to still mean the same thing -- that guard is what stops
-- "drunk" -> "drug"). Shorthand -> canonical section is precisely what the
-- anchor table is for.
insert into public.search_concept_anchors (phrase, doc_type, doc_id, note) values
  ('vfr mins',   'far', '91.155', 'cockpit shorthand'),
  ('wx mins',    'far', '91.155', 'cockpit shorthand'),
  ('vfr wx',     'far', '91.155', 'cockpit shorthand'),
  ('wx minimums','far', '91.155', null),
  ('ifr mins',   'far', '91.175', null),
  ('app mins',   'far', '91.175', null),
  ('pic',        'far', '91.3',   'pilot in command'),
  ('sic',        'far', '61.55',  'second in command'),
  ('xwind',      'aim', '4-3-6',  'crosswind'),
  ('rwy',        'aim', '4-3-6',  null),
  ('elt',        'far', '91.207', null),
  ('mel',        'far', '91.213', null),
  ('mea',        'far', '91.177', null),
  ('mvfr',       'far', '91.155', null)
on conflict (phrase, doc_type, doc_id) do nothing;
