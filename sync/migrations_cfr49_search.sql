-- Wires 49 CFR content into the app's main cross-type search (RC: "our
-- ENTIRE search, SS, ML, etc has to be fully updated to take in, sort, make
-- connections, etc with all of this data"). search_cfr49 mirrors search_far
-- exactly (same anchor/lexical/title-match ranking formula, same
-- has_plus_access() result-count gate) since cfr49_sections/cfr49_parts
-- mirror far_sections/far_parts' shape byte-for-byte -- see
-- migrations_cfr49_schema.sql. Only real difference: joins cfr49_parts to
-- return `family` (HMR/NTSB/TSA), which src/lib/unifiedSearch.ts uses to
-- build the result's display label ("NTSB 830.5", not a bare "830.5").
--
-- search_concept_anchors' doc_type CHECK is extended the same way
-- content_revisions' was (migrations_cfr49_content_revisions_doctype.sql)
-- -- no anchors exist for cfr49 yet (curated content, a separate future
-- pass), but the query shouldn't fail once some are added.
--
-- Deliberately NOT touched this pass (see PROJECT_NOTES/flyregs_pending.md
-- for the full scope note): filter_documents/FilterableType (Home's Filter
-- sheet -- a separate, more tightly-tuned subsystem), SmartSearch's 3-layer
-- query-expansion/bridge-term system, and content_chunks embeddings (Ask
-- FlyRegs semantic search) -- each is its own real build, not a mechanical
-- port like this one.
ALTER TABLE public.search_concept_anchors DROP CONSTRAINT search_concept_anchors_doc_type_check;
ALTER TABLE public.search_concept_anchors ADD CONSTRAINT search_concept_anchors_doc_type_check
  CHECK (doc_type = ANY (ARRAY['far'::text, 'aim'::text, 'pcg'::text, 'ac'::text, 'cfr49'::text]));

CREATE FUNCTION public.search_cfr49(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(section_number text, part text, family text, subpart_title text, title text, out_rank real, is_anchor boolean)
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

GRANT EXECUTE ON FUNCTION public.search_cfr49(text, integer) TO anon, authenticated;
