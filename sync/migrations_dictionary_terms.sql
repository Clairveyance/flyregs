-- ============================================================================
-- Aviation Dictionary  --  2026-08-01
--
-- RC: "the scope/schema for the A/D - large, compendium-sized, full mastery.
-- All terms, all acronyms, all obscure words, phrases, references, oddities
-- ... you must scrape everything bit of aviation data out there to compile
-- this ultimate reference guide." Naming/icon already locked in 2026-08-01
-- (see flyregs_decisions.md's "Aviation Dictionary naming + icon finalized")
-- -- this migration is the actual schema.
--
-- ADDITIVE, not a copy of pcg_terms: the Pilot/Controller Glossary (1,332
-- terms) already has its own screen, search, and MagicLink infrastructure
-- deeply wired through the app. Duplicating that content into a second table
-- would immediately violate feedback_process_flow_required.md (a new content
-- structure ships with its sync pipeline, or it silently drifts the moment
-- P/CG gets edited) and risks re-creating gotcha_pcg_icao_duplicate_terms.md's
-- exact failure (two rows claiming the same headword, whichever loads last
-- silently wins a lookup). dictionary_terms holds ONLY content that doesn't
-- already live in pcg_terms (contractions/acronyms first, handbook glossary
-- terms and informal usage as later tiers) -- the Aviation Dictionary SCREEN
-- is what federates search/browse across both tables, so pcg_terms stays the
-- single source of truth for every term it already owns.
--
-- One row per unique term (never a duplicate headword) is a direct, explicit
-- fix for that same gotcha: multiple senses of one contraction (FAA's own
-- JO 7340.2 lists "A" as 4 different things depending on GEN/NWS/ATC/ICAO
-- context) live together in `senses`, so a lookup by exact term text can
-- never resolve ambiguously.
-- ============================================================================

create table if not exists public.dictionary_terms (
  id              uuid primary key default gen_random_uuid(),
  term            text not null,
  slug            text not null unique,
  letter          text not null,
  category        text not null check (category in ('contraction', 'handbook', 'informal')),
  -- One entry per distinct meaning: {"definition": text, "usage": text | null}.
  -- `usage` carries FAA's own category code from JO 7340.2 (GEN/NWS/ATC/ICAO/
  -- METAR-TAF) when the source distinguishes it; null for tiers that don't.
  senses          jsonb not null,
  source          text not null,       -- e.g. 'FAA JO 7340.2', 'FAA-H-8083-25C'
  pcg_term_id     uuid references public.pcg_terms(id) on delete set null,
  external_refs   jsonb,
  updated_at      timestamptz not null default now(),
  search_vector   tsvector generated always as (to_tsvector('english', term)) stored
);

create index if not exists idx_dictionary_terms_search on public.dictionary_terms using gin (search_vector);
create index if not exists idx_dictionary_terms_letter on public.dictionary_terms (letter);
create index if not exists idx_dictionary_terms_category on public.dictionary_terms (category);

alter table public.dictionary_terms enable row level security;

create policy "dictionary_terms public read" on public.dictionary_terms
  for select using (true);

-- Deliberately narrower than pcg_terms' existing grants (which give anon/
-- authenticated full INSERT/UPDATE/DELETE/TRUNCATE on a public content table
-- -- a pre-existing over-grant, not something to replicate here). Writes are
-- service_role / sync-script only; the API surface for anon/authenticated is
-- read-only, matching what a public reference table should actually allow.
grant select on public.dictionary_terms to anon, authenticated;
grant select, insert, update, delete on public.dictionary_terms to service_role;

-- Mirrors count_pcg_terms_by_letter -- see gotcha_postgrest_1000_row_cap.md:
-- an unfiltered .select() silently truncates at 1000 rows client-side with
-- no error, so per-letter counts across 3,326+ rows need a server-side
-- GROUP BY, not a client count.
create or replace function public.count_dictionary_terms_by_letter()
returns table(letter text, cnt bigint)
language sql
stable
as $$
  select letter, count(*) as cnt from dictionary_terms group by letter;
$$;

grant execute on function public.count_dictionary_terms_by_letter() to anon, authenticated;
