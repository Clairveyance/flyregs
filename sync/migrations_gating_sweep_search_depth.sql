-- Gating sweep 2026-08-11. Search result depth: unlock at Free but capped
-- ~10 results, Plus removes the cap. FREE_RESULT_CAP=10 was only enforced
-- via .slice(0, FREE_RESULT_CAP) at render time in (tabs)/index.tsx; none
-- of the 7 search RPCs clamped result_limit server-side. Live-confirmed: a
-- real signed-in Free-tier session passing result_limit=200 got 200 rows
-- back, 20x the advertised cap. Clamps down to 10 for non-Plus regardless
-- of what the caller asks for; a caller asking for FEWER than 10 is still
-- honored exactly (this only clamps DOWN, never up).
CREATE OR REPLACE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, document_number text, title text, date_issued date, office text, subject_series text, description text, pdf_url_cached text, rank real)
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
  )
  select a.id, a.document_number, a.title, a.date_issued, a.office, a.subject_series, a.description, a.pdf_url_cached,
    (
      case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
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
    )::real as rank
  from advisory_circulars a
  cross join q
  where a.status = 'active'
    and a.search_vector @@ q.or_q
  order by rank desc, a.document_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_ads(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(ad_number text, subject_heading text, out_rank real)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select ad_number, subject_heading,
         ts_rank(search_vector, plainto_tsquery('english', query)) as out_rank
  from airworthiness_directives
  where search_vector @@ plainto_tsquery('english', query)
  order by
    (length(lower(coalesce(body_text,''))) - length(replace(lower(coalesce(body_text,'')), lower(query), ''))) / greatest(length(query), 1) desc,
    out_rank desc
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

CREATE OR REPLACE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real)
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
  )
  select x.slug, x.term, x.definition, x.out_rank
  from (select * from hits union all select * from fallback) x
  order by
    (length(lower(x.term)) - length(replace(lower(x.term), lower(query), ''))) / greatest(length(query), 1) desc,
    x.out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_figures(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(source_type text, figure_id text, parent_id text, parent_number text, parent_title text, label text, caption text, image_url text, out_rank real)
 LANGUAGE sql
 STABLE
AS $function$
  select 'ac' as source_type,
         f.id::text as figure_id,
         ac.id::text as parent_id,
         ac.document_number as parent_number,
         ac.title as parent_title,
         f.label, f.caption, f.image_url,
         ts_rank(f.search_vector, plainto_tsquery('english', query)) as out_rank
  from ac_figures f
  join advisory_circulars ac on ac.id = f.ac_id
  where f.search_vector @@ plainto_tsquery('english', query)
    and public.has_plus_access()

  union all

  select 'aim' as source_type,
         af.id::text as figure_id,
         af.paragraph_number as parent_id,
         af.paragraph_number as parent_number,
         coalesce(ap.title, ap.section_title) as parent_title,
         af.label, af.caption, af.image_url,
         ts_rank(af.search_vector, plainto_tsquery('english', query)) as out_rank
  from aim_figures af
  join aim_paragraphs ap on ap.paragraph_number = af.paragraph_number
  where af.search_vector @@ plainto_tsquery('english', query)

  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

CREATE OR REPLACE FUNCTION public.search_pcg(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real)
 LANGUAGE sql
 STABLE
AS $function$
  select slug, term, definition,
         ts_rank(search_vector, plainto_tsquery('english', query)) as out_rank
  from pcg_terms
  where search_vector @@ plainto_tsquery('english', query)
  order by
    (length(lower(coalesce(definition,''))) - length(replace(lower(coalesce(definition,'')), lower(query), ''))) / greatest(length(query), 1) desc,
    out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;
