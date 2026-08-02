-- ============================================================================
-- semantic_search(): exclude AD administrative boilerplate + add a
-- similarity floor -- 2026-08-02
--
-- RC asked to "really drill down" on Ask FlyRegs's depth/reliability. A 25-
-- query breadth test across all 6 source types found a systemic pattern:
-- generic conceptual questions ("define positive control airspace", "what
-- guidance exists on installing collision avoidance systems", "what is a
-- NOTAM") returned ONLY Airworthiness Directive results, at mediocre
-- similarity (0.40-0.44), crowding out real, more relevant FAR/AIM/PCG/AC
-- content that exists in the corpus (e.g. AC 90-120 -- literally titled
-- "Operational Use of Airborne Collision Avoidance Systems" -- never
-- surfaced for the collision-avoidance query at all).
--
-- Root cause, confirmed by direct sampling: chunk_index=0 for AD documents
-- is, 10/10 sampled and 4,859/15,983 (30%) of all AD chunks corpus-wide,
-- BYTE-IDENTICAL Federal-Register amendatory boilerplate ("PART 39--
-- AIRWORTHINESS DIRECTIVES / 1. The authority citation for part 39
-- continues to read as follows...") -- pure administrative housekeeping
-- language with zero AD-specific content, embedded and searched exactly
-- like substantive chunks. ~4,859 near-identical vectors (10.5% of the
-- ENTIRE 46,270-chunk corpus) sitting close to "generic aviation
-- regulatory language" in embedding space is enough to statistically
-- outcompete a single genuinely-relevant chunk from a rarer source type
-- (AIM has only 870 chunks total, PCG only 926) on any broadly-phrased
-- query.
--
-- Fix has two parts, both zero-cost (no re-embedding, pure retrieval-side):
--   1. Exclude the confirmed-boilerplate chunks from the candidate pool
--      entirely -- narrow LIKE match on the exact confirmed prefix, so
--      this can never accidentally exclude a real AD's genuinely
--      substantive first chunk.
--   2. A similarity floor (0.35) as defense-in-depth against unrelated
--      noise generally -- chosen from the real test data: every genuine
--      match in the breadth test scored >= 0.51, every confirmed-bad
--      result (including a deliberately out-of-scope control query,
--      "what's the best restaurant near KJFK?") scored <= 0.44.
-- ============================================================================
create or replace function public.semantic_search(
  p_query_embedding vector,
  p_content_types text[] default null::text[],
  p_match_count integer default 20
)
returns table(source_type text, source_id text, chunk_index integer, title text, chunk_text text, similarity double precision)
language sql
stable
as $function$
  select
    source_type,
    source_id,
    chunk_index,
    title,
    chunk_text,
    1 - (embedding <=> p_query_embedding) as similarity
  from content_chunks
  where (p_content_types is null or source_type = any(p_content_types))
    and not (source_type = 'ad' and chunk_index = 0 and chunk_text like 'PART 39--AIRWORTHINESS DIRECTIVES%')
    and 1 - (embedding <=> p_query_embedding) >= 0.35
  order by embedding <=> p_query_embedding
  limit p_match_count;
$function$;
