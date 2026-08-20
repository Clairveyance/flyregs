-- Found 2026-08-19/20, full gating re-sweep, immediately after fixing the
-- identical shape in search_dictionary() -- checked every other search_*
-- RPC's return signature for a paid column smuggled past the "search is
-- free, full content is gated" boundary. search_acs() (AC search/rank,
-- used by (tabs)/index.tsx's AC search and lib/refPackSearch.ts) returns
-- `pdf_url_cached` completely unconditionally on every row -- the RPC caps
-- RESULT COUNT for non-Plus (`least(result_limit, 10)`) but never redacted
-- the column itself. SECURITY DEFINER, so the raw-table column-grant fix
-- from earlier this same sweep (migrations_fix_pdf_url_cached_column_grant_
-- leak.sql) does not reach it -- this function runs with the owner's
-- privileges regardless of the caller's own grants, same reason the
-- `_gated` views keep working after that fix.
--
-- Live-confirmed exploitable with the public anon key, zero auth:
--   POST .../rpc/search_acs {"query":"maintenance","result_limit":2}
--   -> real Supabase-storage PDF URLs for 2 Plus-gated ACs.
-- search_far/search_aim/search_cfr49/search_ads/search_legal_interpretations
-- were all checked and confirmed clean -- none return a paid column (FAR/
-- AIM/CFR49 body is free-to-read everywhere in this app by design, AD
-- search only ever returned ad_number/subject_heading, and LOI search was
-- already deliberately built metadata-only, see migrations_paid_content_
-- column_privileges.sql's own comment).
--
-- Fix: CASE-gate pdf_url_cached on has_plus_access(), same shape as
-- advisory_circulars_gated's own redaction and the sibling
-- search_dictionary() fix from earlier this sweep. Metadata/rank/is_anchor
-- stay as-is (search itself is free; the depth cap already limits how much
-- of it a non-Plus caller sees).

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
