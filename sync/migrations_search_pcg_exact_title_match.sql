-- search_pcg: add an exact-title-match bonus, cap the unbounded body-text bonus -- 2026-08-28
--
-- Found while wiring the new phrase-bridge data (search_term_associations)
-- into search: a bridged colloquial phrase resolves to the real P/CG
-- term's own name, which then gets searched literally -- but search_pcg,
-- unlike search_far/search_aim/search_cfr49 (all three of which score an
-- exact search_norm_title(title) = q.phrase match at +1000), had NO exact-
-- title bonus at all. Measured corpus-wide, not guessed: for the 697
-- distinct real P/CG term names the new bridge data resolves to, searching
-- a term by its OWN exact name returned that term as the #1 result only
-- 371 times (53%) -- the other 326 lost to unrelated content whose
-- DEFINITION merely happened to contain the same phrase, because the
-- existing body-text-containment bonus scales UNBOUNDED with occurrence
-- count (each repeat of the phrase in a definition adds another full
-- 1000 points, with no cap) -- e.g. "flight termination" searched
-- literally surfaced LOST_LINK_PROCEDURE (its definition mentions "flight
-- termination" once) ahead of the real FLIGHT TERMINATION term itself.
--
-- Fix, mirroring the FAR/AIM/CFR49 pattern exactly (search_norm_title
-- already exists and applies cleanly to a P/CG term name): add
-- `search_norm_title(c.term) = q.phrase then 1500` (deliberately higher
-- than FAR/AIM/CFR49's 1000, since it also needs to clear the body-
-- containment bonus below) and a matching 300-point partial-title-
-- containment bonus. Also CAP the body-text bonus at 1000 -- the same
-- value a single occurrence already produced, so no single-occurrence
-- case changes at all, only the unbounded multi-occurrence runaway does.
-- Deliberately does NOT touch the anchor boost (2000 + best_len*10) --
-- that's hand-curated, intentional prioritization and stays exactly as
-- powerful as before; a handful of short, generic single-word targets
-- (route, altitude, radar, ...) still lose to a longer anchored term
-- that legitimately competes for that same word, which is existing,
-- deliberate anchor behavior, not something this migration should
-- override.
--
-- Verified: re-ran the same real-corpus correctness check after this fix
-- -- 648/697 (93%) now correct, up from 371/697 (53%). The remaining 49
-- are all the "loses to a legitimately-anchored longer term" case
-- described above, not a new failure mode. Only search_pcg changes here
-- -- search_far/search_aim/search_cfr49 already had this exact-title
-- bonus and are untouched.

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
      + case when search_norm_title(c.term) = q.phrase then 1500 else 0 end
      + case when search_norm_title(c.term) like '%' || q.phrase || '%' then 300 else 0 end
      + least(((length(lower(coalesce(c.definition,''))) - length(replace(lower(coalesce(c.definition,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000, 1000)
      + c.base_rank
      + ln(1 + coalesce(pt.citation_count, 0)) * 5
      + ln(1 + coalesce(pt.search_popularity, 0)) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.slug
  left join pcg_terms pt on pt.slug = c.slug
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

grant execute on function public.search_pcg(text, integer) to anon, authenticated;
