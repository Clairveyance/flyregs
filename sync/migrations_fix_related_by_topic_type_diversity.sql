-- CREATE OR REPLACE with a DIFFERENT parameter list doesn't replace the
-- old function -- Postgres treats it as a new overload (see
-- gotcha_create_or_replace_signature_overload.md), so the OLD 5-arg
-- broken version stayed live alongside this new 6-arg one after the
-- first apply attempt, and PostgREST couldn't resolve an ambiguous call.
-- Drop the old signature explicitly before creating the new one.
DROP FUNCTION IF EXISTS public.related_by_topic(text, text, text[], integer, double precision);

-- Primer query -- see gotcha_hnsw_ef_search_default_starved_recall.md /
-- flyregs_magiclink_semantic_layer.md: a fresh Management-API connection
-- hasn't loaded pgvector's custom GUC yet, so the ALTER FUNCTION ... SET
-- hnsw.ef_search below fails "permission denied to set parameter"
-- (misleading -- not actually a role problem) unless a real vector op runs
-- first in the SAME submitted statement batch.
select 1 - (embedding <=> embedding) from content_chunks limit 1;

-- RC, 2026-08-14, live example: FAR 61.183 (CFI eligibility) discusses
-- spins/spin training; AC 61-67C is literally titled "Stall and Spin
-- Awareness Training" -- an obviously, deeply related document -- but
-- never showed up in 61.183's MagicLink connections. RC: "this is a
-- classic example of how ML is supposed to work. this is a HUGE GAP in
-- the entire ML system design if it can't even relate these two regs.
-- MUST BE FIXED CORPUS WIDE."
--
-- Root-caused, not patched for this one pair: related_by_topic() (built
-- 2026-08-13, see sync/migrations_related_by_topic.sql) already scores AC
-- 61-67C at similarity=0.70 for FAR 61.183 -- comfortably above the 0.45
-- floor, so the SIMILARITY THRESHOLD was never the problem. The real bug
-- is the flat `limit p_match_count` (default 12) applied across ALL
-- target types pooled together. FAR § 61 is an unusually densely
-- self-connected neighborhood -- 61.183 has dozens of OTHER FAR sections
-- about CFI/instructor eligibility and proficiency scoring 0.73-0.86,
-- all higher than AC 61-67C's 0.70 -- so those FAR-to-FAR matches alone
-- fill every one of the 12 slots, and AC 61-67C (genuinely relevant,
-- clears the floor by a wide margin) never gets a chance -- it ranked
-- #62 of 111 total candidates. This is a systemic, corpus-wide bias, not
-- a one-off: ANY document sitting in a dense same-type cluster (which
-- describes most of Part 61, most of Part 91, big multi-section AC
-- families, etc.) will have its cross-type connections -- the whole
-- POINT of a semantic layer built specifically because citation
-- extraction can't cross document types -- silently starved out the same
-- way, regardless of how strong those cross-type matches actually score.
--
-- Fix: guarantee a per-TYPE floor, unioned with the existing global top-N
-- (not a replacement for it -- a document with many genuinely strong
-- same-type neighbors should still show them, this only stops them from
-- crowding out other types entirely). For each requested target_type,
-- take its own top P_PER_TYPE_FLOOR matches that clear the similarity
-- floor, independent of how they'd rank in a pooled comparison, then
-- union with the flat top-N as before. Capped total stays reasonable
-- (p_match_count remains the floor-count baseline; the per-type
-- guarantee can only ADD rows beyond it, never remove any that already
-- qualified).
CREATE OR REPLACE FUNCTION public.related_by_topic(p_source_type text, p_source_id text, p_target_types text[] DEFAULT NULL::text[], p_match_count integer DEFAULT 12, p_min_similarity double precision DEFAULT 0.45, p_per_type_floor integer DEFAULT 8)
 RETURNS TABLE(target_type text, target_id text, title text, similarity double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET "hnsw.ef_search" TO '200'
AS $function$
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
    ),
    qualifying as (
      select * from best_per_doc bpd where bpd.similarity >= p_min_similarity
    ),
    -- Both rankings computed in ONE pass over `qualifying` rather than two
    -- separate CTEs unioned together -- live-timed the union version
    -- against a real densely-connected document (FAR 91.3, one of the most
    -- cross-referenced regs in the whole corpus): 0.3-3.2s depending on
    -- how large `qualifying` happened to be, occasionally close enough to
    -- the client's own request timeout to be a real risk on a page every
    -- real user hits. This shape is logically identical (same two rank
    -- conditions, same result set) but only materializes/sorts
    -- `qualifying` once instead of twice-plus-a-union-dedup.
    ranked as (
      select q.*,
        row_number() over (order by q.similarity desc) as global_rn,
        row_number() over (partition by q.target_type order by q.similarity desc) as type_rn
      from qualifying q
    )
    select r.target_type, r.target_id, r.title, r.similarity
    from ranked r
    where r.global_rn <= p_match_count or r.type_rn <= p_per_type_floor
    order by r.similarity desc;
end;
$function$;

-- The original grant (migrations_related_by_topic.sql) was scoped to the
-- old 5-arg signature, which no longer exists after the DROP above --
-- needs re-granting on the new 6-arg one or every real client call fails
-- with a permission error, not just a "does this even work" question.
grant execute on function public.related_by_topic(text, text, text[], integer, double precision, integer) to anon, authenticated;
