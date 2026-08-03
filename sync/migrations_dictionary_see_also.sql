-- ============================================================================
-- "See X" cross-reference resolution -- 2026-08-02
--
-- RC: "some (like ultralight) don't have enough of a real explanation...
-- check the entire A/D for these issues." Scripted audit found 79 entries
-- whose ENTIRE definition is a bare "See X." stub with zero real content
-- (e.g. ADM -> "See aeronautical decision-making."). 78 of those 79 targets
-- already exist as full entries elsewhere in the dictionary -- the fix
-- isn't new content, it's making "See X" a real tappable link instead of a
-- dead end. 67 resolve unambiguously via a strict match (target text ==
-- some other entry's term with its trailing "(ACRONYM)" qualifier
-- stripped); the remaining ~12 are either genuinely ambiguous (2 equally
-- plausible targets) or have no matching entry at all -- left for manual
-- follow-up rather than guessed. See scratchpad/see_stub_resolutions.json
-- for the full resolved list.
-- ============================================================================

alter table public.dictionary_terms
  add column if not exists see_also_slug text references public.dictionary_terms(slug) on delete set null;

create index if not exists dictionary_terms_see_also_slug_idx on public.dictionary_terms (see_also_slug);
