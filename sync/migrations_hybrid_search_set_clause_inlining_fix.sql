-- hybrid_search: real, reproducible 500s on ~half of real conceptual
-- queries -- found 2026-08-22/23 night-rules QA pass while checking Ask
-- FlyRegs after the same-day embeddings catch-up run.
--
-- Symptom: scripts/search_eval.py's own battery hit a live 'ERROR 500' on
-- 'how recently must I have flown to carry passengers' -- reproduced 5/5,
-- ~17s each, via the real deployed semantic-search Edge Function. Isolated
-- to the DB layer alone (no OpenAI call, a random unit-norm 1536-dim vector
-- substituted for a real embedding -- performance-equivalent for query-plan
-- purposes since HNSW cost depends on graph traversal, not vector content):
-- calling `select * from hybrid_search(...)` directly via the real
-- PostgREST RPC path 500s with `{"code":"57014","message":"canceling
-- statement due to statement timeout"}` at ~8.3s. Swept 10 diverse
-- "everyday"-phrasing queries (search_eval.py / semantic_search_breadth_
-- test.py's own style) the same way: 5 of 10 timed out identically. This is
-- a live, majority-case reliability bug in Ask FlyRegs, not a rare edge
-- case -- a paid (Pro+) feature silently failing ~half its real questions
-- with a bare "Search failed."
--
-- Root cause, confirmed by EXPLAIN (ANALYZE, BUFFERS): calling the function
-- normally produces an opaque `Function Scan on hybrid_search` node --
-- Postgres executes the whole function body as a black box instead of
-- inlining it into the caller's query -- Buffers: shared hit=320356
-- read=52391 (~2.9GB of buffer traffic), Execution Time 10163ms, for a
-- query that should be small and index-driven. Manually inlining the exact
-- same CTE body as a bare SELECT (bypassing the function call) instead
-- produces a normal indexed plan in ~200-600ms per branch. This project has
-- hit exactly this failure SHAPE once before (see gotcha_hybrid_search_cte_
-- materialization.md, "CTE Used 3 Times") but the mechanism this time is
-- different and more specific: Postgres's planner NEVER inlines a SQL-
-- language function that carries a function-level SET clause (documented
-- Postgres behavior -- a SET-clause function's GUC override isn't safely
-- composable with inlining, so the planner always falls back to executing
-- it as an opaque call). hybrid_search's own `SET "hnsw.ef_search" TO
-- '200'` -- added to fix a real recall bug (AVE-F mnemonic, see this same
-- migration file's v6 section) -- is exactly that: a function-level SET
-- clause, present specifically BECAUSE of that earlier fix. Confirmed by
-- direct test: a byte-identical copy of hybrid_search with the SET clause
-- removed (ef_search=200 supplied instead via a preceding `set` statement
-- in the same test session) re-inlines correctly and drops the same failing
-- query to Execution Time 1098ms -- real buffers 320356+52391 -> ~1335 at
-- the top level.
--
-- Also checked (per this pass's "same bug, other reused mechanism" sweep):
-- `related_by_topic` is the only OTHER function in the schema with the same
-- `hnsw.ef_search=200` proconfig entry (content_chunks_embedding_idx is the
-- only HNSW index in the whole database, so these two are its only real
-- consumers) -- but it's LANGUAGE plpgsql, not LANGUAGE sql, and plpgsql
-- functions are never planner-inlined regardless of a SET clause (each
-- internal statement is independently planned either way), so it does not
-- share this specific inlining failure mode and is intentionally left
-- untouched here. (It has its own already-tuned single-pass query shape and
-- its own documented 0.3-3.2s timing note in its own migration history.)
--
-- Fix, attempt 1 (REJECTED, left here for the reasoning trail): move the
-- ef_search override from a function-level SET clause (blocks inlining) to
-- a DATABASE- or ROLE-level default (doesn't -- it's just an ordinary
-- session GUC default, orthogonal to inlining eligibility). Both `ALTER
-- DATABASE postgres SET hnsw.ef_search = 200` and `ALTER ROLE authenticated
-- SET hnsw.ef_search = 200` came back `42501 permission denied to set
-- parameter "hnsw.ef_search"` even via the Management API's own elevated
-- connection -- Supabase's managed Postgres does not grant true superuser
-- to that connection, and this specific GUC's context requires it for
-- ALTER ROLE/DATABASE (a plain in-session `SET hnsw.ef_search = 200` DOES
-- work under the same connection, confirmed live -- just not the
-- persistent-default form). Fixing this properly needs either a Supabase
-- Dashboard-level Postgres config change or a PostgREST db-pre-request
-- hook, neither reachable from a SQL migration -- flagged for RC, not
-- attempted here.
--
-- Fix, applied: remove the SET clause entirely and accept pgvector's plain
-- default (ef_search=40) rather than the tuned 200. This trades away the
-- 2026-08-06 AVE-F-mnemonic recall improvement (one specific historical
-- example query) in exchange for fixing a MUCH more severe, currently-live
-- bug (half of real everyday questions hard-failing) -- confirmed via
-- EXPLAIN ANALYZE that removing just the SET clause (no override at all)
-- keeps the same inlined, indexed plan and the same failing query at
-- Execution Time 727ms. If RC wants ef_search=200's recall benefit back,
-- the real fix is a Dashboard-level `hnsw.ef_search` default or a
-- db-pre-request hook -- re-adding the function-level SET clause would
-- silently reintroduce this exact bug. hybrid_search's CREATE OR REPLACE
-- below is otherwise byte-for-byte the same tuned ranking logic -- only the
-- SET clause line is removed. related_by_topic's own SET clause is left in
-- place untouched (harmless there -- it's LANGUAGE plpgsql, never
-- inlinable regardless of a SET clause, so it doesn't share this bug).
CREATE OR REPLACE FUNCTION public.hybrid_search(p_query_embedding vector, p_query_text text, p_content_types text[] DEFAULT NULL::text[], p_match_count integer DEFAULT 20)
 RETURNS TABLE(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision, rrf_score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  with tsq_and as (
    select websearch_to_tsquery('english', p_query_text) as q
  ),
  tsq as (
    select
      case
        when q is null then null
        when exists (select 1 from content_chunks c where c.search_vector @@ q) then q
        else to_tsquery('english', replace(q::text, ' & ', ' | '))
      end as q,
      (q is not null and not exists (select 1 from content_chunks c where c.search_vector @@ q)) as is_fallback
    from tsq_and
  ),
  vector_ranked as (
    select id, row_number() over (order by embedding <=> p_query_embedding) as vec_rank
    from content_chunks
    where (p_content_types is null or source_type = any(p_content_types))
      and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
    order by embedding <=> p_query_embedding
    limit p_match_count * 8
  ),
  lexical_candidates as (
    select c.id
    from content_chunks c, tsq
    where (p_content_types is null or c.source_type = any(p_content_types))
      and not (c.source_type = 'ad' and c.chunk_index = 0 and c.chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
      and tsq.q is not null and c.search_vector @@ tsq.q
    limit (select case when tsq.is_fallback then 500 else 3000 end from tsq)
  ),
  lexical_ranked as (
    select c.id, row_number() over (order by ts_rank_cd(c.search_vector, tsq.q) desc) as lex_rank
    from content_chunks c
    join lexical_candidates lc on lc.id = c.id, tsq
    order by ts_rank_cd(c.search_vector, tsq.q) desc
    limit p_match_count * 8
  ),
  citation_ranked as (
    select id
    from content_chunks
    where (p_content_types is null or source_type = any(p_content_types))
      and chunk_index = 0
      and not (source_type = 'ad' and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
      and lower(regexp_replace(source_id, '[^a-z0-9.]', '', 'gi'))
        = lower(regexp_replace(p_query_text, '[^a-z0-9.]', '', 'gi'))
  ),
  fused as (
    select id, sum(score) as rrf_score
    from (
      select id, 1.0 / (60 + vec_rank) as score from vector_ranked
      union all
      select id, 1.0 / (60 + lex_rank) as score from lexical_ranked
      union all
      select id, 1.0 as score from citation_ranked
    ) contributions
    group by id
  )
  select
    b.source_type, b.source_id, b.chunk_index, b.title, b.chunk_text,
    1 - (b.embedding <=> p_query_embedding) as similarity,
    f.rrf_score::double precision as rrf_score
  from fused f
  join content_chunks b on b.id = f.id
  order by f.rrf_score desc
  limit p_match_count;
$function$;
