-- Fix a real, corpus-wide retrieval bug: or_q double-stemming    2026-08-20
--
-- RC: "endorsements brings up a bunch of less relevant stuff. 61-65 should
-- be at the top of that list -- it doesn't even show up. this is BAD...
-- maybe it's time you write a special algorithm to make this process truly
-- smart and reliable. we can't keep doing this guessing thing."
--
-- Root cause, confirmed live: search_far/search_aim/search_acs/search_cfr49
-- all built their `or_q` (used for RETRIEVAL, not just ranking -- see each
-- function's own `where a.search_vector @@ q.or_q or an.doc_id is not
-- null`) via:
--   to_tsquery('english', replace(plainto_tsquery('english', resolved)::text, ' & ', ' | '))
-- This takes the ALREADY-STEMMED lexeme string plainto_tsquery produced
-- (e.g. 'endors' for "endorsements" -- Porter-stemmed once, correctly) and
-- feeds it back into to_tsquery, which re-parses and re-stems its input a
-- SECOND time. Stemming an already-stemmed non-word doesn't round-trip:
-- 'endors' stems again to 'endor' -- a lexeme that doesn't exist anywhere
-- in the corpus, since the real stored tsvector entry (from indexing
-- "endorsements" correctly, once) is 'endors', not 'endor'. Confirmed live:
--   select search_vector @@ or_q from advisory_circulars where
--   document_number = '61-65K'  ->  false, even though the document's own
--   text plainly discusses endorsements and matches plainto_tsquery fine.
-- Any query whose Porter stem happens to re-stem differently on a second
-- pass silently loses ALL non-anchored matches -- not a ranking problem,
-- a retrieval one: the row never enters the result set at all, so no
-- amount of anchor curation could ever "guess" its way around this for
-- every affected word corpus-wide.
--
-- Fix: stop round-tripping a stemmed STRING through to_tsquery a second
-- time. Extract the real lexemes from to_tsvector('english', resolved)
-- (which stems words exactly once, correctly) and rebuild or_q from those
-- as PREFIX terms (`lexeme:*`), joined with ' | '. This is the exact,
-- already-proven pattern search_pcg's own fallback tier already uses in
-- production (see its `lexemes`/`filtered`/`wq` CTEs) -- verified why it
-- works where the broken pattern doesn't: to_tsquery still normalizes a
-- `:*`-suffixed term through the dictionary (so 'endors:*' still becomes
-- 'endor':*), but PREFIX matching on the STORED side is "starts with", not
-- exact-equality -- the real stored lexeme 'endors' legitimately starts
-- with the query prefix 'endor', so the match succeeds despite the same
-- double-normalization occurring. Confirmed live before writing this
-- migration: `search_vector @@ (fixed or_q)` -> true for AC 61-65K.
--
-- and_q is UNCHANGED (plainto_tsquery('english', resolved) directly -- no
-- string round-trip, never had this bug) -- only or_q's construction moves.
-- No behavior change to anything currently working: or_q was already
-- intended to be a pure OR of the same words and_q ANDs; this delivers
-- that intent instead of an accidental near-empty query.

-- ============================================================
-- search_far
-- ============================================================
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

-- ============================================================
-- search_aim
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_aim(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
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

-- ============================================================
-- search_cfr49
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_cfr49(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, family text, subpart_title text, title text, out_rank real, is_anchor boolean)
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
  )
  select f.section_number, f.part, p.family, f.subpart_title, f.title,
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
  from cfr49_sections f
  join cfr49_parts p on p.part = f.part
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

-- ============================================================
-- search_acs
-- ============================================================
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
  select a.id, a.document_number, a.title, a.date_issued, a.office, a.subject_series, a.description,
    case when public.has_plus_access() then a.pdf_url_cached else null end as pdf_url_cached,
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
