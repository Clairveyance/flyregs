-- ACS/PTS task -> reg citation density, the free (regex-only, confirmed no
-- LLM needed 2026-08-11) foundation for the relevance/commonality weighting
-- RC asked for. Every ACS/PTS task's own references_text (real FAA
-- authored citations, e.g. "14 CFR parts 1, 61, 91; AC 91-74; AIM") gets
-- parsed into individual (task, cited document) rows here, then aggregated
-- into a density count: how many DISTINCT ACS/PTS tasks cite this section.
-- A FAR section cited by 40 tasks across multiple certificates is core
-- curriculum; one cited by zero is a real signal it's peripheral -- this is
-- the FAA's own ground truth, not a guess.

create table if not exists public.acs_task_citations (
  id uuid primary key default gen_random_uuid(),
  doc_code text not null,
  area_number text not null,
  task_letter text not null,
  cited_type text not null check (cited_type in ('far','ac','aim')),
  cited_id text not null,
  created_at timestamptz not null default now(),
  unique (doc_code, area_number, task_letter, cited_type, cited_id)
);
alter table public.acs_task_citations enable row level security;
drop policy if exists "acs_task_citations_public_read" on public.acs_task_citations;
create policy "acs_task_citations_public_read" on public.acs_task_citations
  for select to public using (true);

create materialized view if not exists public.acs_citation_density as
select cited_type, cited_id,
       count(distinct (doc_code, area_number, task_letter)) as task_count
from public.acs_task_citations
group by cited_type, cited_id;

create unique index if not exists acs_citation_density_pk
  on public.acs_citation_density (cited_type, cited_id);

grant select on public.acs_citation_density to anon, authenticated;
