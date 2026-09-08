-- Make Ask FlyRegs survive a typo in the one word that matters.
--
-- RC, 2026-09-08, from his phone: he asked "Can I go around with a lasso" --
-- autocorrect had turned LAHSO into "lasso" -- and got 15 results, NONE of
-- which mentioned LAHSO or hold-short. The same question spelled correctly
-- puts AIM 4-3-11 first. His note: "our system has to be much smarter than it
-- is to understand what somebody is trying to type even if they don't type the
-- correct thing. Especially in AFR, which... we advertise as being able to
-- understand basic English."
--
-- The anchor `lahso -> aim 4-3-11` already existed. Nothing matched it because
-- search_anchor_matches() is exact, whole-word.
--
-- WHY TRIGRAMS DO NOT SOLVE THIS
-- pg_trgm is the usual reach for fuzzy matching and it is useless here:
-- "lasso" trigrams are {las, ass, sso} and "lahso" are {lah, ahs, hso} -- zero
-- overlap, similarity 0. Levenshtein distance is 1. fuzzystrmatch, already
-- installed, is the right tool.
--
-- THE HARD PART IS NOT MATCHING, IT IS NOT OVER-MATCHING
-- Distance-1 on 5-letter anchors collides with ordinary words: 'loops'/'looks',
-- 'rolls'/'roles'. Two independent guards keep that in check:
--
--   1. The fuzzy pass runs ONLY when the strict pass matched nothing. Every
--      query that works today takes the identical path and cannot change.
--   2. A query word is only treated as a typo if it is NOT IN THE CORPUS
--      VOCABULARY. search_vocabulary holds every term that actually appears in
--      41k documents, so "roles" (doc_freq 6) is a real word and will never be
--      bent into the 'rolls' anchor, while "lasso" appears nowhere in aviation
--      regulation and is therefore almost certainly a misspelling.
--
-- Restricted to SINGLE-WORD anchors of 5+ characters. Multi-word fuzzy matching
-- and short anchors ('bfr', 'elt', 'mea') are where this would start guessing.

create or replace function public.search_anchor_fuzzy_matches(p_query text, p_phrase text)
returns boolean language sql stable as $fn$
  select
    -- single-word anchors only, 5+ chars: below that, distance 1 is most of the word
    p_phrase !~ ' '
    and length(p_phrase) >= 5
    and exists (
      select 1
      from unnest(regexp_split_to_array(lower(p_query), '[^a-z0-9-]+')) as t(w)
      where length(w) >= 5
        and abs(length(w) - length(p_phrase)) <= 1
        and w <> p_phrase
        -- the discriminator: a word that really appears in the corpus is not a typo
        and not exists (select 1 from public.search_vocabulary v where v.term = w)
        and levenshtein(w, p_phrase) = 1
    );
$fn$;

comment on function public.search_anchor_fuzzy_matches(text, text) is
  'Typo-tolerant concept-anchor match. Used by hybrid_search ONLY when the strict '
  'anchor pass found nothing, and only for single-word anchors of 5+ characters '
  'against query words absent from search_vocabulary. See RC 2026-09-08 lasso/LAHSO.';

grant execute on function public.search_anchor_fuzzy_matches(text, text) to authenticated, anon;


-- hybrid_search, with the fuzzy pass wired in as a fallback only.
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
  strict_anchors as (
    select a.doc_type, a.doc_id
    from public.search_concept_anchors a
    where public.search_anchor_matches(lower(p_query_text), a.phrase)
  ),
  -- Typo fallback. Runs ONLY when the strict pass found nothing, so every query
  -- that works today takes the identical path and cannot regress. See
  -- migrations_anchor_typo_tolerance.sql for why this exists (RC's "lasso" for
  -- LAHSO) and why it cannot bend an ordinary word like "roles" into "rolls".
  fuzzy_anchors as (
    select a.doc_type, a.doc_id
    from public.search_concept_anchors a
    where not exists (select 1 from strict_anchors)
      and public.search_anchor_fuzzy_matches(lower(p_query_text), a.phrase)
  ),
  matched_anchors as (
    select doc_type, doc_id from strict_anchors
    union
    select doc_type, doc_id from fuzzy_anchors
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
$function$;
