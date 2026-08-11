-- RC: "close all those gaps, across all regs." Extends the concept-anchor
-- mechanism (search_far/search_aim/search_acs already have it -- see
-- migrations_add_ac_search_anchors.sql for why it matters) to the 3
-- remaining search RPCs: search_pcg, search_ads, search_dictionary.
--
-- All 3 originally ranked with a two-key ORDER BY (substring-match ratio
-- first, ts_rank as tiebreak only) rather than FAR/AC's single composite
-- score. Restructured into one composite `out_rank`/`rank` value with the
-- anchor boost folded in -- the substring-match term is scaled up (*1000)
-- to keep it dominating ts_rank exactly like the original two-key sort
-- did, so ordering among NON-anchored results is unchanged; only the
-- anchor boost (2000+) and the new is_anchor column are additive.
--
-- doc_id in all 3 matches the table's own stable slug/number column
-- (pcg_terms.slug, airworthiness_directives.ad_number,
-- dictionary_terms.slug) -- same pattern as far.doc_id=section_number and
-- ac.doc_id=document_number.

-- ── search_pcg ──────────────────────────────────────────────────────────
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
  )
  select p.slug, p.term, p.definition,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(p.definition,''))) - length(replace(lower(coalesce(p.definition,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + ts_rank(p.search_vector, q.tsq)
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from pcg_terms p
  cross join q
  left join anchors an on an.doc_id = p.slug
  where p.search_vector @@ q.tsq or an.doc_id is not null
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_pcg(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;

-- ── search_ads ──────────────────────────────────────────────────────────
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
  )
  select ad.ad_number, ad.subject_heading,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(ad.body_text,''))) - length(replace(lower(coalesce(ad.body_text,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + ts_rank(ad.search_vector, q.tsq)
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from airworthiness_directives ad
  cross join q
  left join anchors an on an.doc_id = ad.ad_number
  where ad.search_vector @@ q.tsq or an.doc_id is not null
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_ads(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;

-- ── search_dictionary ───────────────────────────────────────────────────
-- Anchor applied AFTER the existing hits/fallback union, not duplicated
-- into both branches -- an anchored term should surface regardless of
-- which tier found it (or even if neither did, same as far/ac/pcg above).
-- Tier-gating on `definition` (mnemonic needs Pro, everything else needs
-- Plus) is untouched, still evaluated per-row exactly as before.
DROP FUNCTION IF EXISTS public.search_dictionary(text, integer);
CREATE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with lexemes as (
    select (m)[1] as clean
    from regexp_matches(to_tsvector('english', query)::text, $$'([^']+)'$$, 'g') as m
  ),
  filtered as (
    select distinct clean from lexemes where length(clean) >= 3
  ),
  pq as (
    select
      to_tsquery('english', string_agg(clean || ':*', ' & ')) as and_q,
      to_tsquery('english', string_agg(clean || ':*', ' | ')) as or_q,
      count(*) as n_lex
    from filtered
  ),
  hits as (
    select d.slug, d.term,
      case when d.category = 'mnemonic'
        then (case when public.has_pro_access() then (d.senses->0->>'definition') else null end)
        else (case when public.has_plus_access() then (d.senses->0->>'definition') else null end)
      end as definition,
      ts_rank(d.search_vector, pq.and_q) as out_rank
    from dictionary_terms d, pq
    where pq.and_q is not null and d.search_vector @@ pq.and_q
  ),
  fallback as (
    select d.slug, d.term,
      case when d.category = 'mnemonic'
        then (case when public.has_pro_access() then (d.senses->0->>'definition') else null end)
        else (case when public.has_plus_access() then (d.senses->0->>'definition') else null end)
      end as definition,
      ts_rank(d.search_vector, pq.or_q) as out_rank
    from dictionary_terms d, pq
    where pq.or_q is not null
      and d.search_vector @@ pq.or_q
      and not exists (select 1 from hits)
      and (
        pq.n_lex <= 2
        or (
          select count(*) from filtered f
          where d.search_vector @@ to_tsquery('english', f.clean || ':*')
        ) >= ceil(pq.n_lex / 2.0)
      )
  ),
  combined as (
    select * from hits union all select * from fallback
  ),
  aq as (
    select btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
  ),
  anchors as (
    select a.doc_id, max(length(a.phrase)) as best_len
    from search_concept_anchors a, aq
    where a.doc_type = 'dictionary'
      and (search_anchor_matches(aq.phrase, a.phrase)
           or (length(aq.phrase) >= 3 and search_phrase_contains(a.phrase, aq.phrase)))
    group by a.doc_id
  ),
  -- An anchored term might not be in `combined` at all (its own tsvector
  -- never matched the query -- exactly the case anchors exist for), so it
  -- has to be pulled in directly here, same tier-gating logic applied.
  anchor_only as (
    select d.slug, d.term,
      case when d.category = 'mnemonic'
        then (case when public.has_pro_access() then (d.senses->0->>'definition') else null end)
        else (case when public.has_plus_access() then (d.senses->0->>'definition') else null end)
      end as definition,
      0::real as out_rank
    from dictionary_terms d, anchors an
    where an.doc_id = d.slug
      and not exists (select 1 from combined c where c.slug = d.slug)
  )
  select x.slug, x.term, x.definition,
    (coalesce(2000 + an.best_len * 10, 0) + x.out_rank)::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from (select * from combined union all select * from anchor_only) x
  left join anchors an on an.doc_id = x.slug
  order by
    (length(lower(x.term)) - length(replace(lower(x.term), lower(query), ''))) / greatest(length(query), 1) desc,
    out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
GRANT EXECUTE ON FUNCTION public.search_dictionary(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;
