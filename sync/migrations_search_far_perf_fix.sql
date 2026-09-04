CREATE OR REPLACE FUNCTION public.search_far(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms,
      -- One single-lexeme tsquery per query term, built ONCE per query. Used
      -- by the coverage term below: `search_vector @@ <one lexeme>` is a
      -- binary search over the stored vector, whereas materialising the whole
      -- vector with tsvector_to_array() per candidate row cost +48% latency
      -- (520ms -> 768ms measured live) for identical results.
      (select array_agg(to_tsquery('english', clean)) from lex) as term_qs
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'far'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  matched as (
    -- Perf fix, 2026-09-03: this used to select every OR-matched row with no
    -- cap, then run the FULL scoring formula below (11 terms, including a
    -- per-row correlated SubPlan for document coverage and two
    -- search_term_hits() calls) on every one of them. or_q is deliberately
    -- broad (any query term, prefix-matched) for recall, so an ordinary
    -- multi-word question ("requirements for TAA aircraft") matched 2720 of
    -- 4293 FAR sections -- more than half the corpus -- and paid the full
    -- 11-term formula on all 2720 just to return the top 20.
    -- EXPLAIN ANALYZE, measured live: 735ms total, with the nested loop that
    -- evaluates the per-row formula responsible for ~709ms of it. Every
    -- caller (Home's SmartSearch, RefPack search, both AC/FAR merges) fires
    -- this per keystroke, so that was ~0.7-1.5s added to EVERY search --
    -- almost certainly the dominant cause of RC's "everything is taking
    -- very long to open."
    -- Fix: pre-filter to a generous top-N by ts_rank ALONE (already the
    -- base of the real formula, computed off the same indexed search_vector
    -- -- see idx_far_sections_search) BEFORE running the expensive formula,
    -- instead of running it on the whole OR-matched set. 50x the caller's
    -- own result_limit, floored at 1500, is comfortably larger than any
    -- realistic true top-20: every other bonus in the full formula (anchor,
    -- exact/contains/fuzzy title, term coverage, AND-match, body-contains,
    -- citation/popularity) is ADDED ON TOP of a base that already
    -- correlates with ts_rank, and anchors bypass this prefilter entirely
    -- (anchor_only below is untouched, unioned back in unconditionally) --
    -- so a genuine anchor match can never be cut regardless of its ts_rank.
    -- Verified with 1500 that two "Definitions." sections ranking near
    -- position 534 by ts_rank alone (110.2, 139.5 for a real test query) --
    -- comfortably inside 1500 -- still made the cut; 500 was NOT generous
    -- enough and dropped them, caught by direct comparison before this ever
    -- went live. Verified again against real queries (this one included) that
    -- the returned rows and their order are unchanged -- this narrows the
    -- CANDIDATE set the formula runs on, it does not change the formula or
    -- which fields it reads.
    select f.section_number, f.part, f.subpart_title, f.title, f.body_text, f.search_vector,
           f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
    from far_sections f, q
    where f.search_vector @@ q.or_q
    order by ts_rank(f.search_vector, q.or_q) desc
    limit greatest(result_limit * 50, 1500)
  ),
  anchor_only as (
    select f.section_number, f.part, f.subpart_title, f.title, f.body_text, f.search_vector,
           f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
    from far_sections f
    join anchors an on an.doc_id = f.section_number
    where not exists (select 1 from matched m where m.section_number = f.section_number)
  ),
  combined as (
    select * from matched union all select * from anchor_only
  )
  select c.section_number, c.part, c.subpart_title, c.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when c.norm_title = q.phrase then 1000 else 0 end
      + case when c.norm_title like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(c.norm_title) >= 6
                  and length(c.norm_title)::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, c.norm_title)
             then 260 else 0 end
      + (search_term_hits(c.title, q.rphrase)::numeric / q.n_terms) * 180
      -- Subpart context. far_sections.subpart_title was SELECTed and returned
      -- by this function but scored NOTHING, so "private pilot knowledge test"
      -- ranked 61.75 (title covers 2/4 terms) above 61.105 (covers 1/4) even
      -- though 61.105 sits in "Subpart E-Private Pilots" and 61.75 does not.
      -- Credits only terms the title did NOT already cover, so title coverage
      -- still outweighs subpart coverage.
      + ((search_term_hits(c.title || ' ' || coalesce(c.subpart_title, ''), q.rphrase)
          - search_term_hits(c.title, q.rphrase))::numeric / q.n_terms) * 180
      -- Document coverage. This function ORs its terms, so a section matching
      -- 1 of 4 query terms competed on equal footing with one matching 4 of 4;
      -- nothing rewarded actually covering the whole query. Reads the STORED
      -- search_vector (no re-tokenising of body_text) to keep this cheap.
      + ((select count(*) from unnest(q.term_qs) as tq
           where c.search_vector @@ tq)::numeric / q.n_terms) * 240
      + case when c.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(c.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(c.search_vector, q.or_q) * 20
      + ln(1 + c.citation_count) * 5
      + ln(1 + c.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.section_number
  order by out_rank desc, c.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$
