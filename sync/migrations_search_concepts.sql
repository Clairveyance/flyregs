-- ============================================================================
-- SmartSearch concept anchors  --  2026-07-31
--
-- Lexical ranking alone cannot answer "cloud clearance". Measured: the top
-- two hits are § 103.23 and § 105.17, both LITERALLY titled "Flight
-- visibility and cloud clearance requirements" — for ultralights and for
-- parachute operations. § 91.155, the section a pilot actually means, says
-- "at a distance from clouds" and never uses the phrase at all. No amount of
-- tf-idf tuning fixes that: the best lexical match is genuinely the wrong
-- answer, and only domain knowledge says so.
--
-- Same shape as the existing bridge layer in src/lib/searchBridge.ts, which
-- is curated for exactly this reason (corpus statistics are blind to a word
-- the corpus never uses). This is the document-level equivalent: the
-- question a pilot asks -> the section that answers it.
--
-- Deliberately SMALL and high-traffic. This is not an attempt to hand-map
-- the corpus; it is the set of questions where the lexically-best answer is
-- known to be wrong, plus the checkride staples. Everything else still ranks
-- purely on the rewritten lexical score.
-- ============================================================================

create table if not exists public.search_concept_anchors (
  id          bigserial primary key,
  phrase      text not null,
  doc_type    text not null check (doc_type in ('far', 'aim', 'pcg', 'ac')),
  doc_id      text not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (phrase, doc_type, doc_id)
);

create index if not exists search_concept_anchors_phrase_idx
  on public.search_concept_anchors (phrase);

grant select on public.search_concept_anchors to anon, authenticated;

alter table public.search_concept_anchors enable row level security;
drop policy if exists concept_anchors_readable on public.search_concept_anchors;
create policy concept_anchors_readable on public.search_concept_anchors
  for select using (true);

insert into public.search_concept_anchors (phrase, doc_type, doc_id, note) values
  -- VFR weather / cloud clearance. The lexical winners (103.23 ultralight,
  -- 105.17 parachute) are the wrong audience.
  ('cloud clearance',            'far', '91.155', 'body says "distance from clouds"'),
  ('cloud clearances',           'far', '91.155', null),
  ('vfr cloud clearance',        'far', '91.155', null),
  ('distance from clouds',       'far', '91.155', null),
  ('vfr minimums',               'far', '91.155', null),
  ('vfr weather minimums',       'far', '91.155', null),
  ('vfr visibility',             'far', '91.155', null),
  ('visibility requirements',    'far', '91.155', null),
  ('how far from clouds',        'far', '91.155', null),
  ('stay away from clouds',      'far', '91.155', null),
  ('special vfr',                'far', '91.157', null),

  -- Class airspace: entry, equipment, comms.
  ('class c',                    'far', '91.130', null),
  ('class charlie',              'far', '91.130', null),
  ('entering class c',           'far', '91.130', null),
  ('class c radio',              'far', '91.130', null),
  ('class c communication',      'far', '91.130', null),
  ('class c requirements',       'far', '91.130', null),
  ('class c',                    'aim', '3-2-4',  null),
  ('class charlie',              'aim', '3-2-4',  null),
  ('entering class c',           'aim', '3-2-4',  null),
  ('class c radio',              'aim', '3-2-4',  null),
  ('class b',                    'far', '91.131', null),
  ('class bravo',                'far', '91.131', null),
  ('class b',                    'aim', '3-2-3',  null),
  ('class d',                    'far', '91.129', null),
  ('class delta',                'far', '91.129', null),
  ('class d',                    'aim', '3-2-5',  null),
  ('class e',                    'aim', '3-2-6',  null),
  ('class g',                    'aim', '3-3-1',  null),
  ('class a',                    'far', '91.135', null),

  -- Preflight / operating rules.
  ('preflight',                  'far', '91.103', null),
  ('preflight action',           'far', '91.103', null),
  ('before a flight',            'far', '91.103', null),
  ('what to check before flying', 'far', '91.103', null),
  ('right of way',               'far', '91.113', null),
  ('who has right of way',       'far', '91.113', null),
  ('minimum safe altitude',      'far', '91.119', null),
  ('how low can i fly',          'far', '91.119', null),
  ('minimum altitude over a city', 'far', '91.119', null),
  ('altitude over congested area', 'far', '91.119', null),
  ('vfr cruising altitude',      'far', '91.159', null),
  ('hemispheric rule',           'far', '91.159', null),
  ('supplemental oxygen',        'far', '91.211', null),
  ('oxygen requirements',        'far', '91.211', null),
  ('when do i need oxygen',      'far', '91.211', null),
  ('transponder',                'far', '91.215', null),
  ('mode c',                     'far', '91.215', null),
  ('adsb',                       'far', '91.225', null),
  ('ads-b',                      'far', '91.225', null),
  ('alcohol',                    'far', '91.17',  null),
  ('eight hours bottle to throttle', 'far', '91.17', null),
  ('drugs and alcohol',          'far', '91.17',  null),
  ('careless or reckless',       'far', '91.13',  null),
  ('pilot in command responsibility', 'far', '91.3', null),
  ('emergency authority',        'far', '91.3',   null),
  ('deviate from a rule',        'far', '91.3',   null),
  ('fuel requirements vfr',      'far', '91.151', null),
  ('vfr fuel reserve',           'far', '91.151', null),
  ('ifr fuel reserve',           'far', '91.167', null),
  ('required instruments vfr',   'far', '91.205', null),
  ('vfr day equipment',          'far', '91.205', null),
  ('inoperative instruments',    'far', '91.213', null),
  ('mel',                        'far', '91.213', null),
  ('seat belts',                 'far', '91.107', null),
  ('sterile cockpit',            'far', '121.542', null),
  ('formation flight',           'far', '91.111', null),
  ('aerobatic flight',           'far', '91.303', null),
  ('parachute requirements',     'far', '91.307', null),
  ('towing gliders',             'far', '91.309', null),

  -- Certification / currency.
  ('night currency',             'far', '61.57',  null),
  ('recent flight experience',   'far', '61.57',  null),
  ('three takeoffs and landings', 'far', '61.57', null),
  ('passenger currency',         'far', '61.57',  null),
  ('instrument currency',        'far', '61.57',  null),
  ('flight review',              'far', '61.56',  null),
  ('biennial flight review',     'far', '61.56',  null),
  ('bfr',                        'far', '61.56',  null),
  ('medical certificate',        'far', '61.23',  null),
  ('medical duration',           'far', '61.23',  null),
  ('basicmed',                   'far', '61.113', null),
  ('private pilot privileges',   'far', '61.113', null),
  ('carrying passengers for compensation', 'far', '61.113', null),
  ('student pilot limitations',  'far', '61.89',  null),
  ('solo requirements',          'far', '61.87',  null),
  ('logging flight time',        'far', '61.51',  null),
  ('logbook',                    'far', '61.51',  null),

  -- Maintenance / airworthiness (mechanic-facing).
  ('annual inspection',          'far', '91.409', null),
  ('100 hour inspection',        'far', '91.409', null),
  ('altimeter check',            'far', '91.411', null),
  ('transponder check',          'far', '91.413', null),
  ('eltrequirements',            'far', '91.207', null),
  ('elt',                        'far', '91.207', null),
  ('airworthiness directives',   'far', '39.7',   null),
  ('preventive maintenance',     'far', '43.3',   null),
  ('who can perform maintenance', 'far', '43.3',  null),
  ('return to service',          'far', '43.7',   null),

  -- AIM procedural staples.
  ('wake turbulence',            'aim', '7-4-1',  null),
  ('land and hold short',        'aim', '4-3-11', null),
  ('lahso',                      'aim', '4-3-11', null),
  ('runway incursion',           'aim', '4-3-1',  null),
  ('light gun signals',          'aim', '4-3-13', null),
  ('lost communications',        'aim', '6-4-1',  null),
  ('emergency procedures',       'aim', '6-1-1',  null),
  ('hypoxia',                    'aim', '8-1-2',  null),
  ('spatial disorientation',     'aim', '8-1-5',  null),
  ('carbon monoxide',            'aim', '8-1-4',  null),
  ('scuba diving before flying', 'aim', '8-1-2',  null),
  ('vfr flight plan',            'aim', '5-1-4',  null),
  ('flight following',           'aim', '4-1-15', null),
  ('transponder codes',          'aim', '4-1-20', null),
  ('squawk codes',               'aim', '4-1-20', null)
on conflict (phrase, doc_type, doc_id) do nothing;
