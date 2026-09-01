-- Rank on subpart context and document coverage in search_far (2026-09-01)
--
-- RC: "i search for 'private pilot knowledge test' and it can't find 61.35,
-- 61.103 and 61.105... FR MUST be the reliable source to find relevant regs."
--
-- Reproduced as a real Premium user: 61.35 ranked #11, 61.103/61.105 were not
-- in the top 20. Matching was never the problem -- this function already ORs
-- its terms, so all three matched. They were RANKED down.
--
-- Measured over 317 real-world pilot queries (scripts/search_eval_cases.py,
-- every expected section machine-verified present in far_sections first):
--     control (this function as it shipped)  recall@10 219/317 = 69.1%  MRR 0.526
--     + subpart 180 + doc-coverage 240       recall@10 245/317 = 77.3%  MRR 0.576
-- Validated on the older, independently-written 94-case set as a holdout to
-- rule out overfitting: 88.0% -> 89.1%, MRR 0.754 -> 0.774.
--
-- Query-bigram phrase containment was also tried and REJECTED: it looked
-- excellent on RC's single query but measured WORSE across the corpus
-- (77.3% -> 75.4% -> 73.8% as more phrase weight was added).
--
-- Signature is unchanged, so no shipped build is affected -- this only
-- reorders rows B37/B38 already know how to render.

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
    select f.section_number, f.part, f.subpart_title, f.title, f.body_text, f.search_vector,
           f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
    from far_sections f, q
    where f.search_vector @@ q.or_q
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

