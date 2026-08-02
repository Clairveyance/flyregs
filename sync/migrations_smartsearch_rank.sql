-- ============================================================================
-- SmartSearch relevance rewrite  --  2026-07-31
--
-- Measured baseline with scripts/smartsearch_bench.py: 10/22 realistic pilot
-- questions returned the right reg at an acceptable position. Worst cases:
--   "VFR cloud clearance requirements" -> § 91.155 at #20
--   "cloud clearance"                  -> § 91.155 at #18
--   "basic VFR weather minimums"       -> § 91.155 at #8  (that IS its title)
--   "how far from clouds must I stay"  -> not in the top 25 at all
--
-- Two structural faults, both in the ORDER BY rather than the matching:
--
-- 1. THE PRIMARY SORT KEY WAS A LITERAL SUBSTRING COUNT of the ENTIRE query
--    against body_text:
--      (length(body) - length(replace(body, query, ''))) / length(query) desc
--    For any multi-word natural-language question that count is 0 for every
--    row, so the real ranking silently collapsed to the tiebreaker. Worse,
--    when it is non-zero it is actively wrong: a section whose body happens
--    to CITE "Basic VFR weather minimums" outranks § 91.155, which is the
--    section actually titled that — its own body never repeats its title.
--
-- 2. search_vector is already weighted (title 'A', number 'A', body 'C') and
--    ts_rank honours that, but ts_rank was only the tiebreaker, so the
--    weighting almost never got to matter.
--
-- The fix keeps OR matching for recall (a question shouldn't return nothing
-- because one word is missing) and does the work in the SCORE instead:
--   exact title match          strongest possible signal
--   title contains the phrase   very strong
--   every query term in title   strong
--   every query term anywhere   medium  (AND-match beats partial match)
--   weighted ts_rank            base ordering
--   body contains the phrase    small boost, no longer the primary key
--
-- Title normalisation matters: FAR titles carry a "§ 91.155 " prefix and a
-- trailing period, so a raw equality test against "basic VFR weather
-- minimums" would never fire.
-- ============================================================================

-- Normalised title for matching: no § number prefix, no trailing period,
-- collapsed whitespace, lowercased.
create or replace function public.search_norm_title(p_title text)
returns text
language sql
immutable
as $function$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(p_title, '')), '^§\s*[0-9]+(\.[0-9]+)?\s*', ''),
      '\.\s*$', ''),
    '\s+', ' ', 'g'));
$function$;

-- How many of the query's content terms appear in a piece of text.
-- Uses the same 'english' stemming the index does, so "requirements" matches
-- "required" rather than missing it.
create or replace function public.search_term_hits(p_text text, p_query text)
returns int
language sql
immutable
as $function$
  select count(*)::int
  from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as t(term)
  where to_tsvector('english', coalesce(p_text, '')) @@ to_tsquery('english', quote_literal(t.term));
$function$;

create or replace function public.search_term_count(p_query text)
returns int
language sql
immutable
as $function$
  select greatest(array_length(tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))), 1), 1);
$function$;

create or replace function public.search_far(query text, result_limit integer default 20)
returns table(section_number text, part text, subpart_title text, title text, out_rank real)
language sql
stable
as $function$
  with q as (
    select
      plainto_tsquery('english', query) as and_q,
      to_tsquery('english', replace(plainto_tsquery('english', query)::text, ' & ', ' | ')) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      search_term_count(query) as n_terms
  )
  select f.section_number, f.part, f.subpart_title, f.title,
    (
      case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      + (search_term_hits(f.title, query)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
    )::real as out_rank
  from far_sections f, q
  where f.search_vector @@ q.or_q
  order by out_rank desc, f.section_number
  limit result_limit;
$function$;

create or replace function public.search_aim(query text, result_limit integer default 20)
returns table(paragraph_number text, chapter text, section_title text, title text, out_rank real)
language sql
stable
as $function$
  with q as (
    select
      plainto_tsquery('english', query) as and_q,
      to_tsquery('english', replace(plainto_tsquery('english', query)::text, ' & ', ' | ')) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      search_term_count(query) as n_terms
  )
  select a.paragraph_number, a.chapter, a.section_title, a.title,
    (
      case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + (search_term_hits(a.title, query)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(a.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
    )::real as out_rank
  from aim_paragraphs a, q
  where a.search_vector @@ q.or_q
  order by out_rank desc, a.paragraph_number
  limit result_limit;
$function$;
