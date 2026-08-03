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

create or replace function public.hybrid_search(
  p_query_embedding vector,
  p_query_text text,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision)
language sql
stable
as $function$
  with tsq as (
    select websearch_to_tsquery('english', p_query_text) as q
  ),
  base as (
    select id, source_type, source_id, chunk_index, title, chunk_text, embedding, search_vector
    from content_chunks
    where (p_content_types is null or source_type = any(p_content_types))
      and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
  ),
  vector_ranked as (
    select id, row_number() over (order by embedding <=> p_query_embedding) as vec_rank
    from base
    order by embedding <=> p_query_embedding
    limit p_match_count * 8
  ),
  lexical_ranked as (
    select id, row_number() over (order by ts_rank_cd(search_vector, tsq.q) desc) as lex_rank
    from base, tsq
    where tsq.q is not null and search_vector @@ tsq.q
    order by ts_rank_cd(search_vector, tsq.q) desc
    limit p_match_count * 8
  ),
  fused as (
    select
      coalesce(v.id, l.id) as id,
      coalesce(1.0 / (60 + v.vec_rank), 0) + coalesce(1.0 / (60 + l.lex_rank), 0) as rrf_score
    from vector_ranked v
    full outer join lexical_ranked l on v.id = l.id
  )
  select
    b.source_type,
    b.source_id,
    b.chunk_index,
    b.title,
    b.chunk_text,
    -- Real cosine similarity, always -- computed here even for rows that
    -- only qualified via the lexical path (may be below the old 0.35
    -- vector-only cutoff, or outside the vector CTE's top-K window
    -- entirely), so the client's existing "% match" display keeps showing
    -- an honest number, not an invented one. Ranking/ORDER is driven by
    -- rrf_score, not by this value -- a low-similarity exact-citation hit
    -- can still rank #1 if it's the clear lexical winner.
    1 - (b.embedding <=> p_query_embedding) as similarity
  from fused f
  join base b on b.id = f.id
  order by f.rrf_score desc
  limit p_match_count;
$function$;
