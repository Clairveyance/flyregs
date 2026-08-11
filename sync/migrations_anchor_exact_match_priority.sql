-- Fix anchor-boost tiebreak: a QUERY that exactly equals one anchor's
-- phrase must always outrank a DIFFERENT anchor whose (longer) phrase
-- merely CONTAINS the query as a substring -- e.g. searching "air
-- traffic control" was landing on AIR_TRAFFIC_CONTROL_SERVICE (anchor
-- phrase "air traffic control service", longer, so higher best_len)
-- instead of the exact-match AIR_TRAFFIC_CONTROL. Root cause: the
-- containment-match rule (search_phrase_contains(a.phrase, q.phrase),
-- query is a substring of a longer curated anchor) is useful on its
-- own, but the existing best_len-based tiebreak silently favored
-- length over precision. Confirmed this isn't P/CG-specific -- a SQL
-- self-join over search_concept_anchors found the same
-- substring-of-another-anchor precondition already present in FAR
-- ("transponder" / "transponder check") and AIM ("wake turbulence" /
-- "wake turbulence avoidance procedures") anchors too, so patching all
-- 6 anchor-aware search functions uniformly rather than just the one
-- where a query happened to expose it today.
--
-- Fix: an exact phrase match now gets length(phrase)+10000 instead of
-- length(phrase) for the best_len tiebreak -- guarantees any exact
-- match outranks any containment-only match regardless of the other
-- anchor's length, while leaving ties among same-kind matches
-- (multiple exact, or multiple containment) exactly as before. Uses
-- CREATE OR REPLACE (return signatures unchanged) so existing GRANTs
-- are preserved automatically -- no DROP FUNCTION needed this time.

CREATE OR REPLACE FUNCTION public.search_far(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
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
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
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
      + case when length(search_norm_title(f.title)) >= 6
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
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_aim(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with rq as (
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
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
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
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_pcg(query text, result_limit integer DEFAULT 20)
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
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
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

CREATE OR REPLACE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real, is_anchor boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET enable_seqscan TO 'off'
AS $function$
  with rq as (
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
  pdf_phrase_hits as (
    select ac2.id
    from advisory_circulars ac2, q
    where ac2.status = 'active'
      and coalesce(lower(ac2.pdf_text), '') like '%' || q.phrase || '%'
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'ac'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select a.id, a.document_number, a.title, a.date_issued, a.office, a.subject_series, a.description, a.pdf_url_cached,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when a.id in (select id from pdf_phrase_hits) then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
    )::real as rank,
    (an.doc_id is not null) as is_anchor
  from advisory_circulars a
  cross join q
  left join anchors an on an.doc_id = a.document_number
  where a.status = 'active'
    and (a.search_vector @@ q.or_q or an.doc_id is not null)
  order by rank desc, a.document_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_ads(query text, result_limit integer DEFAULT 20)
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
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
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

CREATE OR REPLACE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
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
    select a.doc_id, max(case when a.phrase = aq.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
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
