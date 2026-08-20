-- Eliminate redundant search_norm_title() calls in search_far/aim/cfr49   2026-08-20
--
-- RC: "if there's opportunity for improvement in any area, then do it" --
-- re: the ~280ms search_far cost flagged earlier today as smaller/non-
-- blocking and left alone. Went back and found a real, fixable cause
-- rather than leaving it as a shrug.
--
-- Root cause, confirmed by reading the actual EXPLAIN ANALYZE sort-key
-- expression (not assumed): search_far's ranking formula calls
-- search_norm_title(f.title) FOUR SEPARATE TIMES per row (once for the
-- exact-match check, once for the contains check, once for the length/
-- ratio check, and once more nested inside search_phrase_contains) --
-- and Postgres does NOT deduplicate repeated calls to the same function
-- with the same argument within one expression, even when the function is
-- IMMUTABLE. Each call independently re-runs search_norm_title's own 3
-- chained regexp_replace operations. search_aim and search_cfr49 share the
-- exact same formula shape and the exact same bug.
--
-- Fix: restructure all 3 functions onto the matched/anchor_only/combined
-- CTE pattern already used by search_acs/search_ads/search_pcg elsewhere in
-- this same file set -- not a novel technique, just extending an existing,
-- proven convention to the 3 functions that didn't have it yet. This
-- computes search_norm_title(title) exactly ONCE per row, on only the rows
-- that already passed the search_vector/anchor filter (not the whole
-- table), instead of 4 times on every matched row. Ranking math itself is
-- byte-for-byte unchanged -- this only removes redundant computation, it
-- does not change what wins or loses.
create or replace function public.search_far(query text, result_limit integer default 20)
returns table(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
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
      search_term_count(rq.resolved) as n_terms
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
$function$;

create or replace function public.search_aim(query text, result_limit integer default 20)
returns table(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
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
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'aim'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  matched as (
    select a.paragraph_number, a.chapter, a.section_title, a.title, a.body_text, a.search_vector,
           a.citation_count, a.search_popularity, search_norm_title(a.title) as norm_title
    from aim_paragraphs a, q
    where a.search_vector @@ q.or_q
  ),
  anchor_only as (
    select a.paragraph_number, a.chapter, a.section_title, a.title, a.body_text, a.search_vector,
           a.citation_count, a.search_popularity, search_norm_title(a.title) as norm_title
    from aim_paragraphs a
    join anchors an on an.doc_id = a.paragraph_number
    where not exists (select 1 from matched m where m.paragraph_number = a.paragraph_number)
  ),
  combined as (
    select * from matched union all select * from anchor_only
  )
  select c.paragraph_number, c.chapter, c.section_title, c.title,
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
      + case when c.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(c.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(c.search_vector, q.or_q) * 20
      + ln(1 + c.citation_count) * 5
      + ln(1 + c.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.paragraph_number
  order by out_rank desc, c.paragraph_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

create or replace function public.search_cfr49(query text, result_limit integer default 20)
returns table(section_number text, part text, family text, subpart_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
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
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'cfr49'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  matched as (
    select f.section_number, f.part, f.subpart_title, f.title, f.body_text, f.search_vector,
           f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
    from cfr49_sections f, q
    where f.search_vector @@ q.or_q
  ),
  anchor_only as (
    select f.section_number, f.part, f.subpart_title, f.title, f.body_text, f.search_vector,
           f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
    from cfr49_sections f
    join anchors an on an.doc_id = f.section_number
    where not exists (select 1 from matched m where m.section_number = f.section_number)
  ),
  combined as (
    select * from matched union all select * from anchor_only
  )
  select c.section_number, c.part, p.family, c.subpart_title, c.title,
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
      + case when c.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(c.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(c.search_vector, q.or_q) * 20
      + ln(1 + c.citation_count) * 5
      + ln(1 + c.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  join cfr49_parts p on p.part = c.part
  cross join q
  left join anchors an on an.doc_id = c.section_number
  order by out_rank desc, c.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

grant execute on function public.search_far(text, integer) to anon, authenticated;
grant execute on function public.search_aim(text, integer) to anon, authenticated;
grant execute on function public.search_cfr49(text, integer) to anon, authenticated;
