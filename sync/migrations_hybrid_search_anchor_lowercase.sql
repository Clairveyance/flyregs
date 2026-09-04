-- hybrid_search: lowercase the query before anchor matching.
--
-- THE BUG (mine, introduced by migrations_hybrid_search_concept_anchors.sql)
-- --------------------------------------------------------------------------
-- search_anchor_matches() is case-SENSITIVE. It bottoms out in
-- search_phrase_contains(), whose regex is a plain `~` with [^a-z0-9]
-- boundary classes -- so an uppercase letter is treated as a word boundary
-- and 'class g' simply does not match 'Class G airspace'.
--
-- Every OTHER caller already handled this. search_far/aim/pcg/acs/ads/cfr49
-- all build a `q` CTE containing
--     btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
-- and pass THAT to the anchor matcher. My anchor CTE passed the raw
-- p_query_text straight through, so Ask FlyRegs was the one search surface
-- where anchors silently did nothing on a capitalized query.
--
-- Measured against the real deployed edge function (91.205 rank, query
-- "power off glide distance"):
--     "what is power off glide distance"  -> rank 1
--     "What is power off glide distance"  -> rank 1   (anchor words still lowercase)
--     "What Is Power Off Glide Distance"  -> NOT IN TOP 8
-- and RC's own reported query is exactly the failing shape: iOS
-- autocapitalizes, so "Class G airspace" reaches the server with a capital
-- C and matches the 'class g' anchor not at all.
--
-- This is the same lesson as gotcha_afr_semantic_vs_lexical_two_search_paths:
-- there are TWO search backends, and fixing/verifying one proves nothing
-- about the other. I verified the anchor fix earlier using all-lowercase
-- queries, which is precisely the input that hid this.
--
-- Built additively from the LIVE pg_get_functiondef output (migrations drift
-- from the live DB -- see gotcha_migration_files_drift_from_live_db); this
-- file is that output with one call site changed.

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
  matched_anchors as (
    select a.doc_type, a.doc_id
    from public.search_concept_anchors a
    where public.search_anchor_matches(lower(p_query_text), a.phrase)
  ),
  anchor_ranked as (
    select c.id
    from content_chunks c
    join matched_anchors m
      on m.doc_type = c.source_type
     and m.doc_id   = c.source_id
    where (p_content_types is null or c.source_type = any(p_content_types))
      and c.chunk_index = 0
  ),
  fused as (
    select id, sum(score) as rrf_score
    from (
      select id, 1.0 / (60 + vec_rank) as score from vector_ranked
      union all
      select id, 1.0 / (60 + lex_rank) as score from lexical_ranked
      union all
      select id, 1.0 as score from citation_ranked
      union all
      select id, 0.5 as score from anchor_ranked
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
$function$
;
