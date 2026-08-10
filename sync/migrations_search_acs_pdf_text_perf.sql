-- ============================================================================
-- FIX: search_acs slow/timing-out queries via a trigram index instead of a
-- per-row pdf_text LIKE scan                                     2026-08-10
-- ============================================================================
--
-- Follow-up to gotcha_search_acs_permission_denied.md's known, previously
-- unfixed perf bug (RC: "make sure that phrase to query bug in completely
-- fixed and tested multiple times and multiple ways").
--
-- ROOT CAUSE (confirmed via EXPLAIN ANALYZE + direct row/size checks, not
-- guessed): search_acs's ranking formula includes
--   + case when lower(coalesce(a.pdf_text,'')) like '%'||q.phrase||'%' then 40 else 0 end
-- evaluated once per row that passes the outer `search_vector @@ or_q`
-- filter. A broad 2-word OR query ("emergency locator") matches 639 of 782
-- active ACs, and each evaluation forces a full detoast+lowercase of that
-- row's pdf_text (avg 89KB, max 832KB) -- confirmed live, currently
-- reproducible via the REAL deployed PostgREST RPC: "part 135" 500s with
-- `57014 canceling statement due to statement timeout` on the OLD function,
-- right now, in production, not just historically.
--
-- FIRST CANDIDATE FIX TRIED AND REJECTED: swapping the raw LIKE for an
-- indexed phrase check against the existing search_vector GIN index
-- (`a.search_vector @@ phraseto_tsquery('english', q.resolved)`). Validated
-- old-vs-new top-20 order across 15 real queries; 11 were byte-identical,
-- but "night operations" showed a CONFIRMED real recall loss: AC 137-1B and
-- 91-67A both literally contain "night operations" in their pdf_text (both
-- ~20,000-21,000 words) but `search_vector @@ phraseto_tsquery(...)`
-- returned false for both. Root cause of THAT: Postgres tsvector positions
-- are capped at 16383 -- lexemes past that position collapse to a single
-- position value, destroying real phrase-adjacency for any document whose
-- word count exceeds it. Confirmed: both documents are 20K+ words. Do not
-- reintroduce a phraseto_tsquery/tsvector-adjacency approach for this
-- column without solving the long-document position-cap problem first.
--
-- THE FIX THAT SHIPPED: keep the EXACT same predicate (byte-identical LIKE
-- semantics -- zero ranking/result risk by construction), but restructure
-- it from a per-row SELECT-list expression into its own CTE that Postgres
-- can satisfy with a single indexed lookup instead of N per-row
-- evaluations, backed by a new pg_trgm trigram GIN index on
-- coalesce(lower(pdf_text), ''). pg_trgm was already installed (v1.6).
--
-- VERIFIED, multiple ways, before and after shipping:
--   1. Old-vs-new result-set equivalence: 20 real queries (the same 15 used
--      to reject the phrase-query approach, plus 5 more), comparing full
--      (id, document_number, rank rounded to 3 decimals) tuples in exact
--      order -- ALL 20 IDENTICAL, including "night operations" (proving
--      this approach has none of the recall-loss risk the rejected one had,
--      since the predicate itself never changed).
--   2. Edge cases: empty string, single character, a string containing
--      literal LIKE wildcards (%, _) and an apostrophe, and a 500-word
--      query -- all identical old vs new.
--   3. Steady-state timing (3 runs each, after cache warm-up, via direct
--      SQL): "part 135" 6055-6173ms -> 618-677ms (~9-10x); "night
--      operations" 2017-2132ms -> 517-565ms (~4x); "emergency locator"
--      1850-2105ms -> 803-808ms (~2.5x); "wake turbulence" 484-499ms ->
--      114-116ms (~4x); every one of 6 sampled queries improved.
--   4. THE REAL DEPLOYED PATH, not just raw SQL (per this project's own
--      hybrid_search lesson that a lower-level test can look correct while
--      the real path is still broken): called the actual PostgREST RPC
--      endpoint with the anon key, exactly as the app does. OLD function:
--      "part 135" returns HTTP 500 `57014 canceling statement due to
--      statement timeout` -- a real, live, currently-reproducible
--      production bug on an entirely ordinary query. NEW function: HTTP
--      200, ~850ms, 20 correct results. Re-checked "emergency locator",
--      "night operations", "stall warning", "runway", "engine failure" via
--      the same real RPC path post-fix -- all HTTP 200, ~750-1100ms,
--      correct row counts.
--   5. Live UI check in the actual Home screen search (not just the RPC):
--      typed "part 135" into the real search box -- top result "AC 135-7B"
--      matches the RPC's own top result exactly, full results list renders
--      correctly, no errors.
--   6. Full audit suite (scripts/run_all_audits.sh) re-run clean after
--      shipping.
--
-- The `enable_seqscan = off` GUC override from the original permission-bug
-- fix is left in place (unrelated -- it affects the outer search_vector
-- filter, not this pdf_text check) and was not re-evaluated in this pass.

create extension if not exists pg_trgm;

create index if not exists idx_ac_pdf_text_trgm
  on public.advisory_circulars using gin (coalesce(lower(pdf_text), '') gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET enable_seqscan TO 'off'
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
  ),
  -- Computed ONCE as its own indexed lookup (idx_ac_pdf_text_trgm above)
  -- instead of evaluated per row inside the main SELECT list. Same exact
  -- predicate as before -- zero ranking/semantic change -- just
  -- restructured so Postgres can use an index to find the matching set
  -- directly, rather than detoasting every one of a broad query's
  -- candidate rows' full pdf_text (avg 89KB, max 832KB) one at a time.
  pdf_phrase_hits as (
    select ac2.id
    from advisory_circulars ac2, q
    where ac2.status = 'active'
      and coalesce(lower(ac2.pdf_text), '') like '%' || q.phrase || '%'
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
      + case when a.id in (select id from pdf_phrase_hits) then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
    )::real as rank
  from advisory_circulars a
  cross join q
  where a.status = 'active'
    and a.search_vector @@ q.or_q
  order by rank desc, a.document_number
  limit result_limit;
$function$
