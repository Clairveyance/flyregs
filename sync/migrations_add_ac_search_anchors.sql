-- RC, 2026-08-11: "This is just the basis for a new corpus wide sweep on
-- associating and creating relevant connections between all regs. We need
-- to investigate this and see what we're missing."
--
-- Found something structural while following up: search_concept_anchors
-- (the mechanism that lets a curated "the question a pilot asks -> the
-- section that answers it" override a wrong lexical ranking -- see
-- memory/smartsearch_concept_anchors.md) is only wired into search_far
-- and search_aim. search_acs, search_pcg, search_ads, and search_dictionary
-- never even LOOK at the anchors table -- confirmed by grepping every
-- search_* function's source for a reference to search_concept_anchors.
-- That means any "best lexical match is genuinely wrong" case in those 4
-- content types has been structurally unfixable, not just missing a row.
--
-- Concretely confirmed for ACs: "what is the guidance for pilot fitness
-- and fatigue?" returns AIRCRAFT STRUCTURAL fatigue ACs (25.571-1D metal
-- fatigue, 23-13A damage tolerance) ahead of anything about crew rest --
-- "fatigue" is a genuine homonym collision between human factors and
-- structural engineering, exactly the shape of ambiguity anchors exist to
-- resolve, on the exact same kind of pure lexical-scoring RPC search_far
-- had before anchors were added there.
--
-- This migration extends search_acs with the identical anchor CTE/scoring/
-- OR-clause pattern search_far already uses (doc_type = 'ac', matched
-- against advisory_circulars.document_number, the stable human-readable
-- identifier -- not the internal uuid). search_pcg/search_ads/
-- search_dictionary are NOT touched here -- same infrastructure gap,
-- deliberately deferred rather than doing 4 non-trivial RPC rewrites in
-- one pass without individually verifying each; flagged to RC as a
-- follow-up, not silently dropped.
-- Postgres won't let CREATE OR REPLACE change a function's return columns
-- (adding is_anchor) -- has to be dropped first. Same transaction as the
-- CREATE below, so there's no window where the function doesn't exist for
-- a concurrent caller.
DROP FUNCTION IF EXISTS public.search_acs(text, integer);

CREATE FUNCTION public.search_acs(query text, result_limit integer DEFAULT 20)
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
    select a.doc_id, max(length(a.phrase)) as best_len
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

-- DROP FUNCTION wipes grants -- restoring exactly what was there before
-- (confirmed via information_schema.role_routine_grants pre-change:
-- anon, authenticated, service_role, postgres, PUBLIC all had EXECUTE).
GRANT EXECUTE ON FUNCTION public.search_acs(text, integer) TO anon, authenticated, service_role, postgres, PUBLIC;

-- The one confirmed AC gap, added as a first proof this actually works
-- end to end -- 91-82A (Fatigue Management Programs, the real answer for
-- crew/human fatigue) was ranking behind two AIRCRAFT STRUCTURAL fatigue
-- ACs for a question that means human fatigue.
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('pilot fatigue', 'ac', '91-82A', 'homonym collision: "fatigue" alone lexically favors aircraft STRUCTURAL fatigue ACs (25.571-1D, 23-13A) over crew/human fatigue guidance'),
  ('crew fatigue', 'ac', '91-82A', NULL),
  ('fatigue management', 'ac', '91-82A', NULL)
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
