-- URGENT fix, same-session follow-up to migrations_extend_anchors_pcg_ads_
-- dictionary.sql: search_ads started timing out (57014, statement
-- timeout) on ordinary queries immediately after that migration --
-- confirmed live, a real regression, not a hypothetical. Root cause:
-- `WHERE search_vector @@ tsq OR an.doc_id IS NOT NULL` on
-- airworthiness_directives (5599 rows, large body_text per row) defeats
-- the planner's ability to use the tsvector GIN index cleanly for the
-- common case -- confirmed search_acs has `SET enable_seqscan TO 'off'`
-- and search_far is a smaller/differently-shaped table, neither hit this;
-- search_ads had neither protection and is the biggest table of the three
-- extended today.
--
-- Fixed by splitting into two CTEs unioned together instead of one OR'd
-- WHERE clause: `lexical` uses the plain indexed tsvector match with
-- nothing else in its WHERE (clean GIN index scan), `anchor_only` is a
-- direct, tiny join against the (typically 0-3 row) anchors CTE for
-- documents an anchor matches that the lexical search didn't already
-- find. The expensive substring-count scoring math now only ever runs
-- against this small combined/pre-filtered set, not the whole table.
-- Applied the identical restructuring to search_pcg too, proactively --
-- same OR-in-WHERE shape, hadn't timed out in testing yet but no reason
-- to assume it's safe just because it hasn't been hit hard enough.
DROP FUNCTION IF EXISTS public.search_ads(text, integer);
CREATE FUNCTION public.search_ads(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(ad_number text, subject_heading text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (
    select
      plainto_tsquery('english', query) as tsq,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
  ),
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'ad'
      and (search_anchor_matches(q.phrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  lexical as (
    select ad.ad_number, ad.subject_heading, ad.body_text, ad.search_vector
    from airworthiness_directives ad, q
    where ad.search_vector @@ q.tsq
  ),
  anchor_only as (
    select ad.ad_number, ad.subject_heading, ad.body_text, ad.search_vector
    from airworthiness_directives ad
    join anchors an on an.doc_id = ad.ad_number
    where not exists (select 1 from lexical l where l.ad_number = ad.ad_number)
  ),
  combined as (
    select * from lexical union all select * from anchor_only
  )
  select c.ad_number, c.subject_heading,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(c.body_text,''))) - length(replace(lower(coalesce(c.body_text,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + ts_rank(c.search_vector, q.tsq)
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.ad_number
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_ads(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;

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
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'pcg'
      and (search_anchor_matches(q.phrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  lexical as (
    select p.slug, p.term, p.definition, p.search_vector
    from pcg_terms p, q
    where p.search_vector @@ q.tsq
  ),
  anchor_only as (
    select p.slug, p.term, p.definition, p.search_vector
    from pcg_terms p
    join anchors an on an.doc_id = p.slug
    where not exists (select 1 from lexical l where l.slug = p.slug)
  ),
  combined as (
    select * from lexical union all select * from anchor_only
  )
  select c.slug, c.term, c.definition,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(c.definition,''))) - length(replace(lower(coalesce(c.definition,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + ts_rank(c.search_vector, q.tsq)
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.slug
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_pcg(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;
