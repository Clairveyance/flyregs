-- Wire the concept anchors into the two search functions.
--
-- Match rule: the anchor phrase appears in the normalised query as WHOLE
-- WORDS, or the query is a whole-word-complete prefix of the phrase. So
-- "cloud clearance" fires on "VFR cloud clearance requirements", and
-- "class c" fires on "entering class c". The boost is large enough to beat a
-- perfect title match, because a perfect title match is exactly what it
-- exists to override (§ 103.23 "cloud clearance requirements" is an
-- ultralight rule, not what a pilot asking that question wants).
--
-- WORD BOUNDARIES ARE NOT OPTIONAL. A first pass used position(phrase in
-- query) > 0 and was quietly wrong for every short anchor:
--     position('elt'     in 'delta')        = 2
--     position('mel'     in 'melting')      = 1
--     position('class a' in 'class action') = 1
-- so searching "delta" would have force-ranked the ELT rule to the top.
--
-- Longer phrases win: a 3-word anchor is a more specific read of the
-- question than a 1-word one, so the boost scales with phrase length.

-- Whole-word containment, with the needle regex-escaped so an anchor like
-- "ads-b" can't be read as a character class.
create or replace function public.search_phrase_contains(p_haystack text, p_needle text)
returns boolean
language sql
immutable
as $function$
  select p_haystack ~ ('(^|[^a-z0-9])'
    || regexp_replace(p_needle, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
    || '([^a-z0-9]|$)');
$function$;

drop function if exists public.search_far(text, integer);
create function public.search_far(query text, result_limit integer default 20)
returns table(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with rq as (
    -- Resolve the typed words into real corpus vocabulary first, so a
    -- truncated or misspelled word still searches for something ("oxy" and
    -- "oxigen" -> "oxygen"). Falls back to the raw query for anything that
    -- doesn't resolve.
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      to_tsquery('english', replace(plainto_tsquery('english', rq.resolved)::text, ' & ', ' | ')) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'far'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select f.section_number, f.part, f.subpart_title, f.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      -- ...and the REVERSE: the query contains the whole title. "aircraft
      -- speed limits" fully contains § 91.117's title "Aircraft speed",
      -- which is about as strong a signal as there is, but the containment
      -- test above only ran one way and missed it (91.117 ranked #12).
      + case when length(search_norm_title(f.title)) >= 6
                  -- The title must be MOST of the query, not just buried in
                  -- it. Without the ratio, "experimental aircraft operating
                  -- limitations" boosted every section titled "Operating
                  -- limitations" and pushed § 91.319 from #2 to #15.
                  and length(search_norm_title(f.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(f.title))
             then 260 else 0 end
      + (search_term_hits(f.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from far_sections f
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit result_limit;
$function$;

drop function if exists public.search_aim(text, integer);
create function public.search_aim(query text, result_limit integer default 20)
returns table(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with rq as (
    -- Resolve the typed words into real corpus vocabulary first, so a
    -- truncated or misspelled word still searches for something ("oxy" and
    -- "oxigen" -> "oxygen"). Falls back to the raw query for anything that
    -- doesn't resolve.
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      to_tsquery('english', replace(plainto_tsquery('english', rq.resolved)::text, ' & ', ' | ')) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'aim'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select a.paragraph_number, a.chapter, a.section_title, a.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  -- The title must be MOST of the query, not just buried in
                  -- it. Without the ratio, "experimental aircraft operating
                  -- limitations" boosted every section titled "Operating
                  -- limitations" and pushed § 91.319 from #2 to #15.
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(a.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from aim_paragraphs a
  cross join q
  left join anchors an on an.doc_id = a.paragraph_number
  where a.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, a.paragraph_number
  limit result_limit;
$function$;
