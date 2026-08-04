-- ============================================================================
-- Upgrade search_acs() to the same multi-signal ranking as search_far()/
-- search_aim() -- 2026-08-04
--
-- Found while investigating a RefPacks task-bullet search complaint: "a
-- generic multi-word bullet phrase from a RefPack task returned an
-- unrelated turbine-engine AC at rank 0.95." Root cause, confirmed via
-- pg_get_functiondef against the live DB: search_far/search_aim were
-- already rewritten with a real composite score (concept anchors, exact/
-- partial title match, query-contains-title with a length-ratio gate,
-- term-hit-ratio, tsquery match, body substring match, ts_rank as a small
-- final component) -- but search_acs() was never brought along for the
-- ride and was still the original bare `ts_rank` query. Same function
-- used by both Home's search bar (index.tsx) and every RefPack task's
-- "Related Regulations" search (refPackSearch.ts) -- one fix, both
-- surfaces improve.
--
-- Deliberately does NOT add a concept-anchor tier: search_concept_anchors
-- only has doc_type 'far' (117 rows) and 'aim' (25 rows) -- no 'ac' anchors
-- exist. Building that curated layer for 778 active ACs is a separate,
-- much larger content-curation project, not a ranking-formula fix. Every
-- other signal search_far/search_aim use is generic (search_norm_title,
-- search_phrase_contains, search_term_hits, search_term_count,
-- search_resolve_query all take plain text, not table-specific), so this
-- reuses them directly. pdf_text stands in for FAR/AIM's body_text.
--
-- Verified live: the exact reported failure case (multi-word RefPack
-- bullet -> irrelevant turbine-engine AC) now ranks correctly relative to
-- on-topic results; return signature (id, document_number, title,
-- date_issued, office, subject_series, description, pdf_url_cached, rank)
-- is unchanged, so no client code needed to change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      to_tsquery('english', replace(plainto_tsquery('english', rq.resolved)::text, ' & ', ' | ')) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  )
  select a.id, a.document_number, a.title, a.date_issued, a.office, a.subject_series, a.description, a.pdf_url_cached,
    (
      case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(a.pdf_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
    )::real as rank
  from advisory_circulars a
  cross join q
  where a.status = 'active'
    and a.search_vector @@ q.or_q
  order by rank desc, a.document_number
  limit result_limit;
$function$;
