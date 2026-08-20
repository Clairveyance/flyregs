-- Add a citation-authority ranking signal to search    2026-08-20
--
-- RC: "our search, sort, relevance functionality MUST be the best...
-- maybe it's time you write a special algorithm to make this process
-- truly smart and reliable. we can't keep doing this guessing thing."
--
-- Concrete example that exposed the gap: "certification" retrieves AC
-- 61-65K ("Certification: Pilots and Flight and Ground Instructors" --
-- the canonical pilot-certification AC) but ranks it #5, behind several
-- obscure single-purpose ACs (aircraft production-certification fee
-- schedules, glider/airship type-certification bulletins) that happen to
-- also contain the word "certification" in their title. The existing
-- scoring gives every one of those an identical flat "title contains
-- phrase" bonus (+300) plus an identical term-hit bonus (+180) -- the only
-- thing differentiating them afterward is ts_rank, which reflects term
-- density/document length, not real-world importance. There is no
-- principled way to prefer the document most pilots actually need over an
-- obscure one that happens to share a word, without SOME notion of
-- corpus-relative importance.
--
-- document_citations already holds 32k+ real citation edges (built by the
-- existing *_citations.py extraction scripts) -- how often OTHER documents
-- in the corpus reference a given document is a legitimate, well-
-- established authority signal (the same idea behind PageRank: incoming
-- references are evidence of real importance, not a guess). Confirmed live
-- before writing this: AC 61-65K has 11 incoming citations, ahead of most
-- of its "certification" competitors (0-3 each); FAR Part 61 sections
-- (61.51, 61.113, 61.57) are already among the most-cited FAR sections
-- corpus-wide, right alongside 43.x (maintenance) and 91.x (general
-- operating rules) -- exactly the Parts RC says matter most, derived from
-- real corpus structure, not a hand-guessed list.
--
-- Deliberately a PRECOMPUTED column, not a live aggregate join -- search is
-- already flagged as too slow (separate fix pending), and aggregating over
-- a 32k-row table on every keystroke-driven search call would make that
-- worse, not better. citation_count only needs to be as fresh as the
-- citation-extraction scripts themselves run (occasional, not per-search),
-- so a plain indexed-free column read costs the ranking formula nothing
-- beyond what it already pays for any other column reference.
--
-- Log-scaled (ln(1+n)) so a handful of outlier heavily-cross-referenced
-- technical documents (e.g. an airport-lighting-equipment AC cited 33
-- times by other airport-engineering ACs) can't dominate a real title
-- match, and scaled to be a meaningful tie-breaker (bigger than ts_rank's
-- typical few-point spread) without approaching the 180/260/300/1000-point
-- tier bonuses that should still decide when titles are genuinely
-- lexically different.

-- ============================================================
-- Add + populate citation_count on every table these RPCs read
-- ============================================================
alter table advisory_circulars add column if not exists citation_count integer not null default 0;
alter table far_sections add column if not exists citation_count integer not null default 0;
alter table aim_paragraphs add column if not exists citation_count integer not null default 0;
alter table cfr49_sections add column if not exists citation_count integer not null default 0;

-- One-time populate from the current document_citations snapshot. Re-run
-- this UPDATE block (or wrap it in a scheduled refresh) whenever the
-- *_citations.py extraction scripts materially change document_citations --
-- this is corpus-structure data, not per-request data, so occasional
-- refresh is correct, not stale.
update advisory_circulars a
set citation_count = coalesce(c.n, 0)
from (select cited_id, count(*) as n from document_citations where cited_type = 'ac' group by cited_id) c
where c.cited_id = a.document_number;

update far_sections f
set citation_count = coalesce(c.n, 0)
from (select cited_id, count(*) as n from document_citations where cited_type = 'far' group by cited_id) c
where c.cited_id = f.section_number;

update aim_paragraphs a
set citation_count = coalesce(c.n, 0)
from (select cited_id, count(*) as n from document_citations where cited_type = 'aim' group by cited_id) c
where c.cited_id = a.paragraph_number;

update cfr49_sections f
set citation_count = coalesce(c.n, 0)
from (select cited_id, count(*) as n from document_citations where cited_type = 'cfr49' group by cited_id) c
where c.cited_id = f.section_number;

-- ============================================================
-- Wire citation_count into ranking: search_far
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_far(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'far'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select f.section_number, f.part, f.subpart_title, f.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(f.title)) >= 6
                  and length(search_norm_title(f.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(f.title))
             then 260 else 0 end
      + (search_term_hits(f.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
      + ln(1 + f.citation_count) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from far_sections f
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

-- ============================================================
-- search_aim
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_aim(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'aim'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select a.paragraph_number, a.chapter, a.section_title, a.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(a.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
      + ln(1 + a.citation_count) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from aim_paragraphs a
  cross join q
  left join anchors an on an.doc_id = a.paragraph_number
  where a.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, a.paragraph_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

-- ============================================================
-- search_cfr49
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_cfr49(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, family text, subpart_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'cfr49'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select f.section_number, f.part, p.family, f.subpart_title, f.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(f.title)) >= 6
                  and length(search_norm_title(f.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(f.title))
             then 260 else 0 end
      + (search_term_hits(f.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
      + ln(1 + f.citation_count) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from cfr49_sections f
  join cfr49_parts p on p.part = f.part
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

-- ============================================================
-- search_acs
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET enable_seqscan TO 'off'
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  pdf_phrase_hits as (
    select ac2.id
    from advisory_circulars ac2, q
    where ac2.status = 'active'
      and coalesce(lower(ac2.pdf_text), '') like '%' || q.phrase || '%'
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'ac'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select a.id, a.document_number, a.title, a.date_issued, a.office, a.subject_series, a.description,
    case when public.has_plus_access() then a.pdf_url_cached else null end as pdf_url_cached,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when a.id in (select id from pdf_phrase_hits) then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
      + ln(1 + a.citation_count) * 5
    )::real as rank,
    (an.doc_id is not null) as is_anchor
  from advisory_circulars a
  cross join q
  left join anchors an on an.doc_id = a.document_number
  where a.status = 'active'
    and (a.search_vector @@ q.or_q or an.doc_id is not null)
  order by rank desc, a.document_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
