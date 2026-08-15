-- MagicLink semantic relatedness, 2026-08-13. RC, real example (AIM 4-7-3,
-- "Obtaining RNP 10 or RNP 4 Operational Authorization"): "ML only lists a
-- few connections for something like RNPs -- which in reality have TONS of
-- real connections throughout the corpus that ML should be linking to...
-- I need you to get into this deeply, figure out why we STILL aren't
-- getting full info... This is one of our key features we're charging
-- money for. it MUST work perfectly."
--
-- Root cause, confirmed via direct query: MagicLink's existing bars are
-- built ENTIRELY from document_citations, which is populated by each
-- scraper's regex-based citation extractor -- it only ever catches an
-- EXPLICIT textual mention of one document naming another ("AC 90-105",
-- "Pilot/Controller Glossary Term-X", etc). AIM 4-7-3's own body text
-- really does only explicitly name 3 things (AC 90-105 + 2 P/CG terms) --
-- document_citations correctly has exactly those 3 rows, and MagicLink
-- correctly displays exactly those 3. Not a bug in the extraction or the
-- display -- a real architectural ceiling: citation extraction can never
-- surface AIM 1-2-2, 5-4-18, 4-7-2, 5-1-16, or AC 91-70D/90-101A/etc,
-- because AIM 4-7-3's prose never actually writes their numbers down, even
-- though every one of them is genuinely, deeply about the same RNP/RNAV/
-- oceanic-navigation material a pilot studying this paragraph would want
-- surfaced.
--
-- Fix: a second, independent relatedness signal -- topical/semantic, not
-- textual-citation -- built on content_chunks' embeddings, which ALREADY
-- have 100% coverage across all 7 content types (ac/ad/aim/dictionary/far/
-- loi/pcg, 46,319 chunks, confirmed live) from the existing Ask FlyRegs
-- semantic-search infrastructure. Zero new embedding cost. Given a source
-- document, the query vector is the AVERAGE of that document's own chunk
-- embeddings (its semantic "centroid"); candidates are ranked by their own
-- best-matching chunk (so a long document with one highly relevant passage
-- still surfaces, not just documents that are relevant on average).
--
-- Proven live against RC's own RNP example before being trusted: top hits
-- were AC 90-105A (0.848 -- the ALREADY-known-correct explicit citation,
-- landing at the very top validates the whole approach), then AC 91-70D,
-- AC 90-101A, AIM 1-2-2, AC 20-138D, AIM 5-4-18, AC 90-96A, AIM 4-7-5,
-- AC 120-29A, AC 120-118, AIM 4-7-2, AIM 4-7-4, AC 90-100A, AC 120-28D,
-- AIM 5-1-16 -- every single AIM paragraph and AC RC could plausibly have
-- meant by "tons of real connections" is in this list, plus several more
-- a pilot would genuinely want that RC didn't even name.
--
-- PL/pgSQL, not plain SQL, and the centroid is computed as a separate
-- `select ... into` step rather than inline in a CTE/join -- confirmed
-- live this is load-bearing: when the reference vector comes from a
-- correlated subquery in the SAME query plan, Postgres can't treat it as a
-- literal for the HNSW index's ANN operator and falls back to a full
-- sequential scan (6.7s on this corpus, confirmed via EXPLAIN ANALYZE).
-- Materializing the centroid first lets `order by embedding <=> v_centroid
-- limit ...` hit the real index (confirmed via EXPLAIN ANALYZE: ~250ms).
--
-- ef_search=200 (function-level config, not session SET -- Supabase's
-- exposed `postgres` role can't SET this custom GUC directly; ALTER
-- FUNCTION ... SET attaches it to pg_proc.proconfig instead, applied on
-- every call regardless of caller, matching hybrid_search's own existing
-- fix for the exact same "ef_search default (40) silently starves ANN
-- recall" issue documented after the 2026-08-06 lost-comms-mnemonic
-- investigation) -- confirmed this recovers full recall (all 15 of the
-- RNP example's real top matches, not just the ~5 the unfixed default
-- returned) while staying fast.
-- security definer -- content_chunks has RLS enabled with zero policies
-- (confirmed live), so a plain function called via the client's own anon/
-- authenticated key returned an empty array every time, no error, silently
-- wrong -- the existing Ask FlyRegs semantic-search RPCs only ever work
-- because that feature's real call path goes through an Edge Function
-- using the service-role key, not a direct client-side supabase.rpc() call
-- the way MagicLink's own citation queries work. Safe here specifically
-- because this function's return shape is (type, id, title, similarity)
-- only -- never chunk_text -- matching the same "titles are ungated, body
-- text is what's actually tier-protected" precedent MagicLinkPod.tsx's own
-- TITLE_SOURCE already established; this doesn't touch content_chunks'
-- grants/policies at all, so raw-table access for any other consumer is
-- completely unchanged.
create or replace function public.related_by_topic(
  p_source_type text,
  p_source_id text,
  p_target_types text[] default null,
  p_match_count int default 12,
  p_min_similarity double precision default 0.45
)
returns table(target_type text, target_id text, title text, similarity double precision)
language plpgsql stable security definer as $$
declare
  v_centroid vector(1536);
begin
  select avg(embedding) into v_centroid
  from content_chunks
  where source_type = p_source_type and source_id = p_source_id;

  if v_centroid is null then
    return;
  end if;

  return query
    with nearest_chunks as (
      select cc.source_type, cc.source_id, cc.title,
        1 - (cc.embedding <=> v_centroid) as similarity
      from content_chunks cc
      where not (cc.source_type = p_source_type and cc.source_id = p_source_id)
        and (p_target_types is null or cc.source_type = any(p_target_types))
      order by cc.embedding <=> v_centroid
      limit 200
    ),
    best_per_doc as (
      select distinct on (nc.source_type, nc.source_id)
        nc.source_type as target_type, nc.source_id as target_id, nc.title, nc.similarity
      from nearest_chunks nc
      order by nc.source_type, nc.source_id, nc.similarity desc
    )
    select * from best_per_doc
    where best_per_doc.similarity >= p_min_similarity
    order by best_per_doc.similarity desc
    limit p_match_count;
end;
$$;

grant execute on function public.related_by_topic(text, text, text[], int, double precision) to anon, authenticated;

-- Real vector op ahead of the ALTER in the SAME submitted statement --
-- confirmed live this is what makes the ALTER succeed at all (a fresh
-- Management-API backend hasn't loaded the vector extension's custom GUC
-- yet; without this, ALTER FUNCTION ... SET hnsw.ef_search fails with
-- "permission denied to set parameter", which reads like a role/privilege
-- problem but isn't one).
select 1 - (embedding <=> embedding) from content_chunks limit 1;
alter function public.related_by_topic(text, text, text[], int, double precision) set hnsw.ef_search = 200;
