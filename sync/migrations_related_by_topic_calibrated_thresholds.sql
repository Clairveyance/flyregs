-- Calibrate MagicLink's semantic-relatedness thresholds per content type,
-- and exclude AD entirely pending a real content fix   2026-08-24
--
-- RC: "this is one of our primary feature, so it must be a 'Wow' for
-- users... And it has to work, everywhere, perfectly." Dispatched two
-- research agents to hand-judge real match quality rather than guess --
-- 1,637 source->candidate pairs total, reading actual body text on both
-- sides, banded by similarity score. Full writeups in this session's own
-- transcript/notes. Summary of what they found:
--
-- The flat 0.45 floor sits at ~11% pooled precision -- the P/CG "ABEAM"
-- spot-check that started this investigation wasn't a fluke, it's
-- representative. But a single global number can't fix this well:
--   - far/aim: their real (relevant) matches are ALL already scoring above
--     0.55 -- confirmed live, raising the floor to 0.55 costs 0% recall
--     while cutting the entire 11-13%-precision noise band below it. A
--     pure win, no tradeoff.
--   - pcg: recall drops much faster above 0.45 than far/aim (96% at .45 ->
--     88% at .50 -> 75% at .55 -> 45% at .60), so a conservative floor
--     (0.50) is the right call here -- cuts the worst band only.
--   - ac/loi: "close to free" in the 0.55-0.60 range (0-7% recall cost)
--     while cutting a real boilerplate-genre noise band around 0.65-0.70.
--   - ad: cannot be fixed by ANY threshold. Every one of 13 tested AD
--     sources had its worst false positives (different defect, different
--     airframe) scored in the EXACT SAME 0.79-0.94 range as its best true
--     positives (same fleet-defect campaign) -- precision stays flat ~7%
--     relevant from 0.45 to 0.94. Root cause: AD chunks embed the
--     standard "PART 39--AIRWORTHINESS DIRECTIVES... Authority: 49 U.S.C.
--     106(g)..." boilerplate preamble alongside the real defect text, and
--     that shared administrative boilerplate dominates the embedding for
--     most short ADs -- confirmed both AD-as-source (contaminates its own
--     centroid) and AD-as-target (other documents spuriously match AD
--     candidates on the same boilerplate, e.g. a random LOI scored
--     0.77-0.82 against 27 of 29 AD candidates on pure regulatory-
--     boilerplate similarity, zero real topical connection). The real fix
--     needs AD chunks re-embedded starting from unsafe_condition/subject
--     text, skipping the preamble -- a genuine re-embedding cost, not
--     done in this migration, needs its own scoping/go-ahead. Showing
--     confidently wrong AD matches is worse than showing none, so AD is
--     excluded entirely (both directions) until that real fix lands.
--
-- Both known-good gold-standard examples re-verified to still clear their
-- new floors: AIM 4-7-3 -> AC 90-105A (0.848 >> 0.58) and FAR 61.183 ->
-- AC 61-67C (0.693-0.727 >> 0.58) both still surface correctly.
--
-- p_min_similarity itself is preserved as an ADDITIONAL floor via
-- GREATEST() -- a future caller can still ask for an even higher bar, but
-- can no longer request anything below these calibrated per-type minimums
-- through this function. (Research access to the raw, unfiltered spread
-- -- e.g. to recalibrate later -- still works by querying content_chunks
-- directly, same as this investigation did for its diagnostic work.)

-- Primer query -- see gotcha_hnsw_ef_search_default_starved_recall.md: a
-- fresh Management-API connection hasn't loaded pgvector's custom GUC yet,
-- so the ALTER-equivalent SET "hnsw.ef_search" below fails "permission
-- denied to set parameter" unless a real vector op runs first in the SAME
-- submitted statement batch.
SELECT 1 - (embedding <=> embedding) FROM content_chunks LIMIT 1;

CREATE OR REPLACE FUNCTION public.related_by_topic(p_source_type text, p_source_id text, p_target_types text[] DEFAULT NULL::text[], p_match_count integer DEFAULT 12, p_min_similarity double precision DEFAULT 0.45, p_per_type_floor integer DEFAULT 8)
 RETURNS TABLE(target_type text, target_id text, title text, similarity double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET "hnsw.ef_search" TO '200'
AS $function$
declare
  v_centroid vector(1536);
begin
  if p_source_type = 'ad' then
    return;
  end if;

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
        and cc.source_type <> 'ad'
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
      select * from best_per_doc bpd
      where bpd.similarity >= greatest(p_min_similarity, case bpd.target_type
        when 'far' then 0.55
        when 'aim' then 0.55
        when 'pcg' then 0.50
        when 'ac' then 0.58
        when 'loi' then 0.58
        -- dictionary, cfr49, and any future type: not covered by either
        -- research pass (both were scoped to the 6 types with a real
        -- content_revisions/"What's Changed" lineage -- far/aim/pcg/ac/ad/
        -- loi). Caught live while verifying this fix: P/CG "ABEAM" started
        -- surfacing 'dictionary'-type mnemonic entries that fell straight
        -- through to the OLD broken p_min_similarity default (0.45) since
        -- nothing else applied to them. Same conservative floor as pcg
        -- (0.50, short glossary-style content, closest analog) rather than
        -- leaving an unresearched type on the exact number this whole
        -- migration exists to move away from.
        else 0.50
      end)
    ),
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
