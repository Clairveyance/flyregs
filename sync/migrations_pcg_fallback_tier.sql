-- RC: "close all those gaps, across all regs" / "do all rounds of realistic
-- Qs across all topic... do it all." Realistic-question sweep found P/CG
-- returning ZERO results for very ordinary phrasing -- "meaning of go
-- around", "what does cleared to land mean", "definition of runway
-- incursion" -- even though the terms genuinely exist in the corpus
-- (confirmed: plainto_tsquery('meaning of go around') -> 'mean' & 'go' &
-- 'around', an AND query; GO_AROUND's own definition never contains the
-- word "mean", so the AND fails and the row is invisible to search no
-- matter how it's ranked). This is a retrieval-completeness bug, not a
-- ranking bug -- no anchor can fix a row that never enters the result set.
--
-- search_dictionary already solves exactly this with a two-tier hits (AND)
-- / fallback (OR, only when hits is empty, gated by word-count so it
-- doesn't turn into noise on long queries) structure. P/CG rows are the
-- same shape as dictionary rows (short term + short definition, easy for
-- an AND-tsquery to fail on filler words), so it's the same fix, applied
-- here instead of reinventing one.
--
-- Did NOT extend this to search_far/search_aim/search_acs/search_ads --
-- the large per-row body/definition text on those 4 gives an AND-tsquery
-- far more surface area to match against, and the realistic-question sweep
-- run against all 4 this session found wrong-rank issues but zero true
-- retrieval misses. Retrofitting an unproven fix onto working functions
-- is exactly the mistake that caused the search_ads timeout earlier this
-- session -- only touching what's actually confirmed broken.
DROP FUNCTION IF EXISTS public.search_pcg(text, integer);
CREATE FUNCTION public.search_pcg(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with q as (
    select
      plainto_tsquery('english', query) as tsq,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
  ),
  lexemes as (
    select (m)[1] as clean
    from regexp_matches(to_tsvector('english', query)::text, $$'([^']+)'$$, 'g') as m
  ),
  filtered as (
    select distinct clean from lexemes where length(clean) >= 3
  ),
  wq as (
    select
      to_tsquery('english', string_agg(clean || ':*', ' & ')) as and_q,
      to_tsquery('english', string_agg(clean || ':*', ' | ')) as or_q,
      count(*) as n_lex
    from filtered
  ),
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'pcg'
      and (search_anchor_matches(q.phrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  lexical as (
    select p.slug, p.term, p.definition, p.search_vector, ts_rank(p.search_vector, q.tsq) as base_rank
    from pcg_terms p, q
    where p.search_vector @@ q.tsq
  ),
  -- Only fires when the strict AND tier found NOTHING at all (query-wide,
  -- matching search_dictionary's semantics exactly) -- this is a rescue
  -- path for otherwise-empty results, not a general loosening of every
  -- search. The n_lex<=2-or-half-match guard keeps long, wordy questions
  -- from matching on a single incidental shared word.
  fallback as (
    select p.slug, p.term, p.definition, p.search_vector, ts_rank(p.search_vector, wq.or_q) as base_rank
    from pcg_terms p, wq
    where wq.or_q is not null
      and p.search_vector @@ wq.or_q
      and not exists (select 1 from lexical)
      and (
        wq.n_lex <= 2
        or (
          select count(*) from filtered f
          where p.search_vector @@ to_tsquery('english', f.clean || ':*')
        ) >= ceil(wq.n_lex / 2.0)
      )
  ),
  anchor_only as (
    select p.slug, p.term, p.definition, p.search_vector, 0::real as base_rank
    from pcg_terms p
    join anchors an on an.doc_id = p.slug
    where not exists (select 1 from lexical l where l.slug = p.slug)
      and not exists (select 1 from fallback fb where fb.slug = p.slug)
  ),
  combined as (
    select * from lexical
    union all select * from fallback
    union all select * from anchor_only
  )
  select c.slug, c.term, c.definition,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(c.definition,''))) - length(replace(lower(coalesce(c.definition,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + c.base_rank
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.slug
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_pcg(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;
