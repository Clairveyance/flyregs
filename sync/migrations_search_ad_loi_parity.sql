-- Bring AD/LOI search up to parity with FAR/AIM/P-CG/AC/CFR49          2026-08-20
--
-- RC: "make sure this search fix covers all regs corpus wide." Corpus-wide
-- sweep of every search_* RPC (not just the ones already touched today)
-- found two real gaps in the two doc types left out of that earlier pass --
-- Airworthiness Directives and Legal Interpretations (LOI) are both
-- genuinely part of "the regs corpus," not a separate feature.
--
-- Finding #1 (severe): search_legal_interpretations computed
-- to_tsvector('english', coalesce(body_text,'')) LIVE, per row, on every
-- single call -- no materialized/indexed tsvector column at all, unlike
-- every other doc type. Measured: 1,561ms for search_legal_interpretations
-- ('certification', 20) -- worse than the search_acs bug fixed earlier
-- today (798ms). It also had zero ranking sophistication versus the other
-- 5 corpus RPCs: no concept-anchor support, no citation-authority signal,
-- ordered by nothing but year/slug once matched.
--
-- Finding #2: search_ads (Airworthiness Directives) already has a real
-- generated+indexed search_vector column (no latency crisis -- measured
-- 106ms), but like LOI, was never wired into the citation_count signal
-- added earlier today, so it has no authority-based ranking at all.
--
-- Also: search_concept_anchors' own CHECK constraint only permitted
-- doc_type in ('far','aim','pcg','ac','cfr49') -- widened to include 'ad'
-- and 'loi' so a future genuinely-ambiguous AD/LOI query has the same
-- last-resort fix available every other doc type already has, even though
-- no anchors exist for either yet.

alter table search_concept_anchors drop constraint search_concept_anchors_doc_type_check;
alter table search_concept_anchors add constraint search_concept_anchors_doc_type_check
  check (doc_type = any (array['far','aim','pcg','ac','cfr49','ad','loi']));

-- ── citation_count + search_popularity on both tables, same pattern as
-- advisory_circulars/far_sections/aim_paragraphs/cfr49_sections earlier
-- today. search_popularity starts real but empty (see the companion
-- search-popularity-logging migration) -- inert until real usage
-- accumulates, not fabricated.
alter table airworthiness_directives add column if not exists citation_count integer not null default 0;
alter table airworthiness_directives add column if not exists search_popularity integer not null default 0;
alter table legal_interpretations add column if not exists citation_count integer not null default 0;
alter table legal_interpretations add column if not exists search_popularity integer not null default 0;

update airworthiness_directives ad set citation_count = c.n
from (select cited_id, count(*) as n from document_citations where cited_type = 'ad' group by cited_id) c
where c.cited_id = ad.ad_number;

update legal_interpretations l set citation_count = c.n
from (select cited_id, count(*) as n from document_citations where cited_type = 'loi' group by cited_id) c
where c.cited_id = l.slug;

-- ── legal_interpretations: replace the live-computed tsvector with a real
-- generated+indexed column, same weighting convention as ac_fts_vector
-- (identifying/title-ish text at 'A', descriptive metadata at 'B', full
-- body at 'C'). LOI titles are auto-generated filenames ("Colvin-
-- JPSAviation_2011_Legal_Interpretation"), not real descriptive titles --
-- unlike FAR/AC, nobody searches those, so `summary` (the one genuinely
-- human-readable topic field this table has) carries the 'A' weight
-- instead of `title`, and stands in for `title`'s role in the term-hit-
-- density ranking term below.
alter table legal_interpretations add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(addressee, '') || ' ' || coalesce(cfr_part_reference, '') || ' ' || coalesce(cfr_section_reference, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) stored;

create index if not exists idx_legal_interpretations_search on legal_interpretations using gin(search_vector);
drop index if exists legal_interpretations_fts_idx;

create or replace function public.search_legal_interpretations(q text, lim integer default 50)
returns table(slug text, title text, addressee text, year integer, summary text, cfr_part_reference text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(q), ''), q) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  qq as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(coalesce(q, '')), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      greatest(search_term_count(rq.resolved), 1) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = qq.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, qq
    where a.doc_type = 'loi'
      and (search_anchor_matches(qq.phrase, a.phrase)
           or search_anchor_matches(qq.rphrase, a.phrase)
           or (length(qq.phrase) >= 3 and search_phrase_contains(a.phrase, qq.phrase)))
    group by a.doc_id
  )
  select l.slug, l.title, l.addressee, l.year, l.summary, l.cfr_part_reference
  from legal_interpretations l
  cross join qq
  left join anchors an on an.doc_id = l.slug
  where q is null or btrim(q) = ''
     or l.search_vector @@ qq.or_q
     or an.doc_id is not null
  order by
    (
      coalesce(2000 + an.best_len * 10, 0)
      + (search_term_hits(coalesce(l.summary, ''), qq.rphrase)::numeric / qq.n_terms) * 180
      + case when l.search_vector @@ qq.and_q then 60 else 0 end
      + ts_rank(l.search_vector, qq.or_q) * 20
      + ln(1 + l.citation_count) * 5
      + ln(1 + l.search_popularity) * 5
    )::real desc nulls last,
    l.year desc nulls last, l.slug
  limit (case when public.has_plus_access() then least(coalesce(lim, 50), 200) else least(coalesce(lim, 50), 10) end);
$function$;

grant execute on function public.search_legal_interpretations(text, integer) to anon, authenticated;

-- ── search_ads: same existing structure/logic, threading citation_count
-- and search_popularity through the CTE chain (they weren't carried before
-- since the function only needed body_text/search_vector until now).
create or replace function public.search_ads(query text, result_limit integer default 20)
returns table(ad_number text, subject_heading text, out_rank real, is_anchor boolean)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with q as (
    select
      plainto_tsquery('english', query) as tsq,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'ad'
      and (search_anchor_matches(q.phrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  lexical as (
    select ad.ad_number, ad.subject_heading, ad.body_text, ad.search_vector, ad.citation_count, ad.search_popularity
    from airworthiness_directives ad, q
    where ad.search_vector @@ q.tsq
  ),
  anchor_only as (
    select ad.ad_number, ad.subject_heading, ad.body_text, ad.search_vector, ad.citation_count, ad.search_popularity
    from airworthiness_directives ad
    join anchors an on an.doc_id = ad.ad_number
    where not exists (select 1 from lexical l where l.ad_number = ad.ad_number)
  ),
  combined as (
    select * from lexical union all select * from anchor_only
  )
  select c.ad_number, c.subject_heading,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(c.body_text,''))) - length(replace(lower(coalesce(c.body_text,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + ts_rank(c.search_vector, q.tsq)
      + ln(1 + c.citation_count) * 5
      + ln(1 + c.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.ad_number
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

grant execute on function public.search_ads(text, integer) to anon, authenticated;
