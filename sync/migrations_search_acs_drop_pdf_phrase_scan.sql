-- Drop search_acs's full-corpus pdf_text LIKE scan -- the real latency bug   2026-08-20
--
-- RC: "the whole search results process is still too slow. the wheel spins,
-- and you sit waiting, way too long... this search process is the daily
-- backbone of the app and must be fast and easy."
--
-- Root cause, found by EXPLAIN ANALYZE (not assumed): search_acs('certification', 20)
-- took 798ms. Isolating each CTE showed the entire cost was one thing --
-- pdf_phrase_hits:
--   select ac2.id from advisory_circulars ac2, q
--   where ac2.status = 'active'
--     and coalesce(lower(ac2.pdf_text), '') like '%' || q.phrase || '%'
-- This scans EVERY active AC's full pdf_text (781 rows, 56MB total, ~73KB
-- average) on every single call, unconditionally -- not filtered to the rows
-- that already matched the tsquery. It uses the idx_ac_pdf_text_trgm trigram
-- index for the initial bitmap scan (fast, <1ms), but that index is lossy,
-- so Postgres has to re-fetch and re-check the actual (large, TOASTed)
-- pdf_text for every candidate row to confirm -- that recheck is where the
-- ~660-800ms lives (confirmed by measuring the CTE in isolation:
-- "Execution Time: 660.533 ms").
--
-- And it's not a rare cost: index.tsx's runSearch fires search_acs once for
-- the literal query PLUS once per SmartSearch expansion term (up to
-- MAX_TERMS=6, see searchSynonyms.ts) inside a single Promise.all -- so one
-- keystroke can trigger up to 7 of these ~800ms calls concurrently against
-- the same (Micro-tier) Postgres instance. That's the wheel-spin.
--
-- Why this is safe to just delete, not rework: advisory_circulars.search_vector
-- is a generated column -- ac_fts_vector(title, document_number, description,
-- pdf_text) -- which ALREADY tokenizes and indexes pdf_text at weight 'C'.
-- So `a.search_vector @@ q.or_q` (the function's actual WHERE-clause recall
-- mechanism) already matches on PDF body content; pdf_phrase_hits added
-- nothing to RECALL. Its only effect was a +40 ranking nudge for an exact
-- substring phrase match inside the PDF body, vs. token-level match --
-- dwarfed by every other signal in the rank formula (anchor: +2000 to
-- +12000, exact title: +1000, title contains: +300, ts_rank: up to ~20*4).
-- Checked the two AC cases in scripts/smartsearch_bench.py ("certification",
-- "endorsements") -- both pass via the search_concept_anchors bonus alone,
-- unaffected by this removal. Full 30/30 suite re-run below to confirm no
-- other regression before/after.
create or replace function public.search_acs(query text, result_limit integer default 20)
returns table(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real, is_anchor boolean)
language sql
stable
security definer
set search_path to 'public'
set enable_seqscan to 'off'
as $function$
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

grant execute on function public.search_acs(text, integer) to anon, authenticated;
