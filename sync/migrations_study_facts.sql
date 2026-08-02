-- study_facts: authored fact-recall Q/A cards (RC's Class C shape: Q is one
-- short sentence about the CONTENT, A is a short factual phrase), distinct
-- from the reference-recall cards buildStudyCard() generates deterministically
-- client-side. These need real authoring -- an LLM pass over body text --
-- so they're stored, not generated on the fly. See
-- PROJECT_NOTES/flyregs_fact_deck_scope.md for the scoping/pricing this
-- table backs; authoring itself runs via scripts/author_fact_deck.py
-- (Batches API, model recorded per-row for audit).
create table if not exists public.study_facts (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('far', 'aim')),
  -- matches study_progress.item_id exactly (far_sections.section_number /
  -- aim_paragraphs.paragraph_number) so a fact card can share the SAME
  -- spaced-repetition row as that item's reference-recall card rather than
  -- forking progress tracking per fact.
  item_id text not null,
  question text not null,
  answer text not null,
  -- the source sentence/phrase the answer is grounded in -- lets a human
  -- spot-check a flagged card against the actual reg text without opening
  -- the full section.
  source_quote text not null,
  status text not null default 'pending' check (status in ('pending', 'live', 'flagged', 'stale')),
  model text not null,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_model text,
  unique (item_type, item_id, question)
);

create index if not exists study_facts_live_idx on public.study_facts (item_type, item_id) where status = 'live';

alter table public.study_facts enable row level security;

drop policy if exists "study_facts public read" on public.study_facts;
create policy "study_facts public read" on public.study_facts
  for select using (status = 'live');

-- service_role (scripts) bypasses RLS already; no separate write policy needed.
