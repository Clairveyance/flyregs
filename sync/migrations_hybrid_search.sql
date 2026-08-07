-- Hybrid lexical + semantic scoring for Ask FlyRegs (task #64).
--
-- Problem confirmed live: semantic_search() is pure pgvector cosine-
-- similarity search with no lexical component. A bare citation-number
-- query ("61.87") embeds into a generic, low-information vector that
-- matches on loose numeric/technical "vibes" rather than the actual
-- citation -- confirmed live returning an AC's turbine-engine damage-
-- tolerance data table (full of decimal numbers) as the #1 result for
-- "61.87" instead of the real FAR § 61.87. This is a different failure
-- mode than the earlier HNSW recall fix (gotcha_semantic_search_hnsw_recall)
-- -- that fixed the index missing objectively-good vector matches; this
-- fixes queries where the vector space itself has no good signal to find,
-- because the query is mostly/only an exact token a full-text search
-- would nail immediately.
--
-- Fix: add real Postgres full-text search to content_chunks, and fuse it
-- with the existing vector search via Reciprocal Rank Fusion (RRF) --
-- standard, parameter-light hybrid-search technique that sidesteps trying
-- to normalize two incomparable score scales (cosine similarity in [0,1]
-- vs. ts_rank's unbounded distribution). A document ranks well if it's
-- near the top of EITHER list; a document that's top of both wins
-- outright. `websearch_to_tsquery` (not `to_tsquery`) specifically because
-- it never throws on stray punctuation/operators in raw user questions --
-- confirmed live it correctly parses a full natural-language question.

-- Plain column + trigger, NOT `generated always as (...) stored` -- a
-- stored generated column forces one atomic full-table rewrite (computing
-- to_tsvector for all 46,270 existing rows in a single statement), which
-- cannot complete through the Supabase Management API: confirmed hitting
-- both Postgres's own statement_timeout AND, after raising that, a hard
-- Cloudflare 524 edge timeout in front of api.supabase.com that no
-- statement_timeout setting can affect (same constraint already documented
-- in gotcha_semantic_search_hnsw_recall.md for the earlier HNSW rebuild).
-- A plain column can be backfilled in small batches instead (see the
-- backfill loop below, run separately), and a trigger keeps it current on
-- every future insert without needing another full-table pass.
alter table public.content_chunks
  add column if not exists search_vector tsvector;

create or replace function public.content_chunks_search_vector_trigger() returns trigger as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.chunk_text, ''));
  return new;
end;
$$ language plpgsql;

drop trigger if exists content_chunks_search_vector_update on public.content_chunks;
create trigger content_chunks_search_vector_update
  before insert or update of title, chunk_text on public.content_chunks
  for each row execute function public.content_chunks_search_vector_trigger();

create index if not exists content_chunks_search_vector_idx
  on public.content_chunks using gin (search_vector);

-- v2, 2026-08-04: plain RRF (vector + lexical only) turned out to NOT
-- actually fix the "61.87" motivating case above. Verified live with a
-- real query embedding before wiring this into the Edge Function: FAR
-- § 61.87's own chunks ranked ~20th on the lexical side for the query
-- "61.87", because ts_rank_cd measures term density/frequency within a
-- chunk, and a section doesn't repeat its own citation number in its own
-- body -- other documents that happen to CITE "61.87" several times (an
-- LOI, an AC) scored higher purely on density, so the #1 result was still
-- an unrelated AC. RRF alone is the right tool for conceptual queries
-- (confirmed working well) but a bare citation lookup needs a third,
-- different signal: does the query text match this document's OWN
-- identifier. Added a citation_ranked CTE for that (see v3 below for its
-- final form) -- a document's chunk_index=0 row flagged when source_id
-- matches the (lightly normalized -- strips "§"/spaces/case) query text
-- exactly, contributing a flat +1.0 in `fused`, larger than any possible
-- vector+lexical RRF sum (max ~0.033), so it always wins the final
-- ORDER BY when it fires, and never touches ranking for conceptual
-- queries (no source_id will ever match free text).
--
-- v3, 2026-08-04: v2 was correct but caused a severe, load-bearing perf
-- regression -- caught ONLY because this was tested through the real
-- deployed Edge Function path (PostgREST), not just the Management API's
-- direct-SQL path used earlier, which turned out to have a much longer
-- (or no) statement_timeout and silently absorbed the slowness. v2 routed
-- vector_ranked, lexical_ranked, AND citation_ranked all through one
-- shared `base` CTE. Because `base` had 3 consumers, Postgres chose to
-- materialize it ONCE into a tuplestore rather than inline it 3 times --
-- reasonable in isolation, but it means vector_ranked's `order by embedding
-- <=> ... limit N` then runs against that materialized tuplestore instead
-- of the real table, so the HNSW index (content_chunks_embedding_idx)
-- can't be used at all: confirmed via EXPLAIN ANALYZE, the vector CTE fell
-- back to an external-merge disk sort over all 41K+ rows, and the whole
-- function took 50 SECONDS -- every real query through PostgREST just
-- 500'd with `57014 canceling statement due to statement timeout`. Fixed
-- by having vector_ranked, lexical_ranked, and citation_ranked each query
-- content_chunks DIRECTLY (own copy of the WHERE filter each), so none of
-- them share a materialized intermediate -- confirmed via EXPLAIN ANALYZE
-- this restores the HNSW index scan for vector_ranked. That still left
-- citation_ranked itself slow (~7.5s: chunk_index=0 narrows to ~13K rows,
-- then the regexp_replace() normalization has to be evaluated against
-- each one with no supporting index) -- fixed with a dedicated partial
-- expression index (below) so it becomes a direct index lookup instead.
-- Full function now 16ms end to end, down from 50,000ms.
create index if not exists content_chunks_source_id_normalized_idx
  on public.content_chunks (lower(regexp_replace(source_id, '[^a-z0-9.]', '', 'gi')))
  where chunk_index = 0;

-- v4, 2026-08-04: v3 was correct AND fast at the database layer, but
-- end-to-end verification through the real Edge Function (not just direct
-- SQL) still returned the WRONG top result for "61.87" -- because
-- supabase/functions/semantic-search/index.ts re-sorted the RPC's results
-- by raw `similarity` (a leftover from the old pure-vector semantic_search
-- RPC, where similarity WAS the only signal), silently discarding this
-- function's own rrf_score ordering. FAR 61.87's real cosine similarity
-- (0.20) is much lower than a document that merely LOOKS similar in
-- embedding space (0.41), so the client-side re-sort put the citation
-- boost's winner right back at the bottom. Fixed by adding rrf_score as an
-- output column here so the Edge Function can rank by IT instead --
-- `similarity` is still returned and still shown to the client as the
-- honest "% match" number, it's just no longer what determines order.
create or replace function public.hybrid_search(
  p_query_embedding vector,
  p_query_text text,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision, rrf_score double precision)
language sql
stable
as $function$
  with tsq as (
    select websearch_to_tsquery('english', p_query_text) as q
  ),
  vector_ranked as (
    select id, row_number() over (order by embedding <=> p_query_embedding) as vec_rank
    from content_chunks
    where (p_content_types is null or source_type = any(p_content_types))
      and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
    order by embedding <=> p_query_embedding
    limit p_match_count * 8
  ),
  lexical_ranked as (
    select id, row_number() over (order by ts_rank_cd(search_vector, tsq.q) desc) as lex_rank
    from content_chunks, tsq
    where (p_content_types is null or source_type = any(p_content_types))
      and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
      and tsq.q is not null and search_vector @@ tsq.q
    order by ts_rank_cd(search_vector, tsq.q) desc
    limit p_match_count * 8
  ),
  -- Own copy of the same filters as vector_ranked/lexical_ranked, and
  -- backed by content_chunks_source_id_normalized_idx above -- see v3
  -- note. Deliberately NOT routed through a shared CTE with the other two
  -- (see v3 note for why that's a performance trap, not just a style
  -- choice).
  citation_ranked as (
    select id
    from content_chunks
    where (p_content_types is null or source_type = any(p_content_types))
      and chunk_index = 0
      and not (source_type = 'ad' and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
      and lower(regexp_replace(source_id, '[^a-z0-9.]', '', 'gi'))
        = lower(regexp_replace(p_query_text, '[^a-z0-9.]', '', 'gi'))
  ),
  -- Sum-of-contributions (not nested full outer joins) so a document that
  -- ONLY matches via citation_ranked -- outside both the vector and
  -- lexical top-K windows entirely -- still gets included with its +1.0,
  -- rather than needing to already be present in one of the other two
  -- CTEs to receive it.
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
    b.source_type,
    b.source_id,
    b.chunk_index,
    b.title,
    b.chunk_text,
    -- Real cosine similarity, always -- computed here even for rows that
    -- only qualified via the lexical/citation path (may be below the old
    -- 0.35 vector-only cutoff, or outside the vector CTE's top-K window
    -- entirely), so the client's existing "% match" display keeps showing
    -- an honest number, not an invented one. NOT what ORDER BY uses below
    -- (see v4 note) -- shown to the client, doesn't drive ranking.
    1 - (b.embedding <=> p_query_embedding) as similarity,
    f.rrf_score::double precision as rrf_score
  from fused f
  join content_chunks b on b.id = f.id
  order by f.rrf_score desc
  limit p_match_count;
$function$;

-- Verified live end to end through the REAL deployed Edge Function (not
-- direct SQL -- see the v3 note for why that distinction mattered), real
-- OpenAI query embeddings, 4 cases:
--   "61.87" -> #1 is FAR § 61.87 itself (sim 0.201), correctly above the
--              AC turbine-rotor table that used to win (sim 0.413).
--   "what is the cloud clearance requirement for VFR flight" -> clean,
--              on-topic AIM/FAR results, citation_ranked correctly
--              contributes nothing (no source_id matches free text).
--   "Are there any airworthiness directives about Lycoming engine
--              crankshafts?" -> top 5 are all genuinely-dominant Lycoming
--              ADs, confirming the AD/LOI discount (now proportional on
--              rrf_score, see index.ts) still lets a clearly-best AD win
--              outright rather than always losing to the FAR/AIM/PCG/AC
--              preference.
--   "what guidance exists on installing airborne collision avoidance
--              systems?" -> AC 90-120 (the exact document the
--              RAW_FETCH_MULTIPLIER widening was built for, 2026-08-02)
--              still ranks #1, confirming that fix wasn't regressed by
--              the ranking-signal switch.

-- v6, 2026-08-06: RC asked for a real, non-arbitrary fix for the AVE-F
-- mnemonic's ranking (not a per-document boost) and asked what ef_search's
-- widened window (see the separate `ALTER FUNCTION ... SET hnsw.ef_search`
-- fix, applied directly, not versioned in this file) actually covers.
-- Confirmed via an EXACT (index-disabled) sequential scan: AVE-F's true
-- rank by pure vector similarity, among ALL 46,270 chunks, is #120
-- (similarity 0.4248) -- a real, honest number, not an approximation
-- artifact. ef_search=200 already covers that; retrieval isn't the
-- remaining gap.
--
-- What IS a real, corpus-wide, no-cost, non-arbitrary gap: websearch_to_
-- tsquery's default semantics AND every significant word together. For
-- RC's exact query ("how do i know which ifr route to fly with lost
-- comms" -> 'know' & 'ifr' & 'rout' & 'fli' & 'lost' & 'comm' after
-- stemming), confirmed live: ZERO of the 46,270 chunks satisfy that full
-- conjunction -- not even FAR 91.185 itself, whose own body text says
-- "communications" (stems to 'commun') rather than the informal "comms"
-- (stems to 'comm'). Any natural-language question carrying 5+ real
-- content words is structurally unlikely to ever satisfy a full AND across
-- all of them, so hybrid_search's lexical signal has been contributing
-- NOTHING to ranking on exactly the query type ("Ask FlyRegs" natural-
-- language questions) this feature exists for -- silently 100%
-- vector-only for queries like this the whole time.
--
-- Fix: fall back to an OR-combined version of the SAME stemmed query terms
-- (built by textually converting the already-correctly-stemmed AND-tsquery
-- from '&' to '|', not re-deriving it -- so stopword/stemming behavior
-- stays identical) ONLY when the strict AND version matches zero rows
-- corpus-wide. A cheap EXISTS check (GIN-indexed, same index the real scan
-- already uses) decides which to use. Deliberately NOT a blanket AND->OR
-- switch: any query where the strict conjunction already finds real
-- matches (the vast majority of shorter/lexical queries, e.g. "runway
-- markings", "61.87") is completely unaffected -- same tsquery, same
-- lexical_ranked candidates, same behavior as v5. The fallback only ever
-- activates for a query that would otherwise get ZERO lexical signal, so
-- it can only ever ADD real, honest partial-term-overlap credit where none
-- existed, never take precision away from a query that already worked.
create or replace function public.hybrid_search(
  p_query_embedding vector,
  p_query_text text,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision, rrf_score double precision)
language sql
stable
as $function$
  with tsq_and as (
    select websearch_to_tsquery('english', p_query_text) as q
  ),
  tsq as (
    select
      case
        when q is null then null
        when exists (select 1 from content_chunks c where c.search_vector @@ q) then q
        else to_tsquery('english', replace(q::text, ' & ', ' | '))
      end as q
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
  lexical_ranked as (
    select id, row_number() over (order by ts_rank_cd(search_vector, tsq.q) desc) as lex_rank
    from content_chunks, tsq
    where (p_content_types is null or source_type = any(p_content_types))
      and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
      and tsq.q is not null and search_vector @@ tsq.q
    order by ts_rank_cd(search_vector, tsq.q) desc
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

-- v6 SHIPPED BROKEN, corrected same session -- kept here for the reasoning
-- trail per this project's own convention, not because v6 was ever the
-- final state. Live-tested v6 directly against the AVE-F query and it
-- worked; the search_eval.py re-run (which tries the FULL case list, not
-- one query) caught what a single manual test couldn't: TWO other
-- real, previously-working queries ("distress call when in serious
-- danger", "how recently must I have flown to carry passengers") ALSO
-- have an AND-tsquery that matches zero rows -- so they ALSO triggered
-- the new OR-fallback branch, and for THOSE queries the OR-matched
-- candidate set was large enough (common words like "call"/"danger") that
-- ts_rank_cd over the full match set blew the caller's statement_timeout:
-- confirmed live via direct PostgREST curl -- `{"code":"57014",
-- "message":"canceling statement due to statement timeout"}`. Two
-- real, working production queries started hard-failing.
--
-- v7 fix: cap the fallback's candidate pool to 3000 rows via a real LIMIT
-- BEFORE ts_rank_cd ever runs (a `lexical_candidates` CTE), so lexical
-- ranking cost is bounded no matter how common the OR'd terms are. Costs
-- nothing extra for the normal (AND-matched) case -- that candidate set is
-- already almost always under 3000, so this LIMIT is a no-op there.
-- Re-verified live: all three previously-failing queries return 200 (3-6s
-- each -- slower than the ~2.5s baseline, but no more hard failures), and
-- the full search_eval.py suite runs clean with zero errors.
create or replace function public.hybrid_search(
  p_query_embedding vector,
  p_query_text text,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision, rrf_score double precision)
language sql
stable
as $function$
  with tsq_and as (
    select websearch_to_tsquery('english', p_query_text) as q
  ),
  tsq as (
    select
      case
        when q is null then null
        when exists (select 1 from content_chunks c where c.search_vector @@ q) then q
        else to_tsquery('english', replace(q::text, ' & ', ' | '))
      end as q
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
    limit 3000
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

-- Re-apply the ef_search config: CREATE OR REPLACE on a `language sql`
-- function preserves proconfig in Postgres, but re-asserting costs nothing
-- and removes any doubt.
alter function public.hybrid_search(vector, text, text[], integer) set hnsw.ef_search = 200;

-- Verified (v7): scripts/search_eval.py full suite, zero errors,
-- zero forbidden-result violations. Real, honest trade-off found and kept
-- (not silently accepted) -- see the "how recently must I have flown..."
-- case's own WATCH comment in search_eval.py: this fix is a net positive
-- for the conceptual/natural-language query set as a whole (R@1 0.25->0.33,
-- MRR 0.48->0.52) but does inject noise into at least one other
-- previously-correct case. See [[gotcha_lexical_and_query_zero_match_fallback]]

-- v9, 2026-08-06: v7's "no more hard failures" claim did not hold up under
-- more load. Two full search_eval.py runs later the same day (RC asked for
-- mnemonic wording enrichment, unrelated to this function) both hit a real,
-- reproducible 500 on "distress call when in serious danger" and "how do i
-- know which ifr route to fly with lost comms" -- the exact query this whole
-- fallback exists for. EXPLAIN (ANALYZE, BUFFERS, TIMING) on the real query
-- showed 6.8s total, with `lexical_candidates` ALONE costing 2.1s: its
-- `limit 3000` does not stop Postgres from doing a full Bitmap Heap Scan
-- (with per-row Recheck Cond, since the GIN bitmap is lossy) over every row
-- satisfying the OR'd tsquery BEFORE the limit is applied -- confirmed the
-- OR'd terms for "distress"/"call"/"serious"/"danger" match 6000+ rows, and
-- Postgres does not short-circuit that scan early.
--
-- First attempt (WRONG, would have shipped a worse regression): just drop
-- the `limit 3000` to `limit 500` unconditionally. Isolated-CTE timing
-- looked great (2.1s -> 0.26s) and the crash was gone -- but a full
-- search_eval.py run showed lexical R@1 cratering 0.90 -> 0.50. Root cause
-- of THAT: `lexical_candidates` is NOT fallback-only -- it runs for every
-- query, including the completely normal AND-matched lexical case. "runway
-- markings" alone AND-matches 592 real rows in the corpus (confirmed via
-- EXPLAIN) -- MORE than a 500-row cap, so a plain lexical query's own best
-- match could fall outside an arbitrary (no ORDER BY) 500-row bitmap-scan
-- sample. The 3000 cap was never the problem for that case (256ms, cheap);
-- only the RARE fallback case (an OR'd query matching thousands of common
-- words) was ever slow. Reverted to 3000 immediately upon seeing this,
-- confirmed the revert restored the 0.90 baseline, THEN built the real fix.
--
-- Real fix: track whether the fallback actually fired (`tsq.is_fallback`)
-- and only clamp the candidate cap down to 500 in that specific case;
-- normal AND-matched queries keep the full 3000 they never needed shrinking.
-- Verified: real query 6.8s -> 2.25s (EXPLAIN), two independent full
-- search_eval.py runs both show the EXACT same numbers as v7's baseline
-- (ALL R@1=0.62/R@3=0.81/R@5=0.86/MRR=0.73, lexical R@1=0.90, conceptual
-- R@1=0.22/MRR=0.46, citation 1.00) with ZERO errors on either
-- previously-crashing query. No ranking-quality cost, real reliability win.
create or replace function public.hybrid_search(
  p_query_embedding vector,
  p_query_text text,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision, rrf_score double precision)
language sql
stable
as $function$
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

alter function public.hybrid_search(vector, text, text[], integer) set hnsw.ef_search = 200;

-- Not fully resolved even after v9: the fallback path is still ~2.25s for
-- the worst case (down from 6.8s, but not fast). If corpus growth or load
-- pushes it back toward the timeout edge again, the next lever is likely
-- rewriting lexical_candidates to pick its candidates in a cheaper order
-- (e.g. by document frequency of the rarest OR'd term first) rather than
-- an arbitrary bitmap-scan sample, so a smaller cap doesn't cost recall.
-- for the full incident writeup (the v6 crash, root cause, and the v7 fix).
