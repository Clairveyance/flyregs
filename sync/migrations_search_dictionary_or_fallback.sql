-- ============================================================================
-- search_dictionary: OR-fallback for correctly-spelled multi-word queries
-- ============================================================================
-- RC named this specific gap weeks ago ("Fix search_dictionary's brittle
-- AND-only tsquery issue") -- flagged, never actually fixed. hybrid_search
-- got the equivalent fix back on 2026-08-06 (see gotcha_lexical_and_query_
-- zero_match_fallback.md) for Ask FlyRegs' main search; search_dictionary
-- was a separate function and never got the same treatment.
--
-- Confirmed live, unchanged until now: the primary tier builds a strict AND
-- prefix-tsquery (`string_agg(clean || ':*', ' & ')`) -- a real,
-- correctly-spelled multi-word dictionary query where the words don't all
-- appear together in the SAME term+definition falls straight through to
-- the misspelling-correction tier, which can't help (the words aren't
-- misspelled) and returns nothing either.
--
-- New middle tier, inserted between the existing two: when the strict AND
-- finds zero rows, retry with the SAME (uncorrected) prefix terms OR'd
-- together instead of AND'd, before falling to spell-correction. Mirrors
-- hybrid_search's proven v7 pattern (convert the tsquery text itself,
-- ' & ' -> ' | ', so stemming/prefix-matching stays identical) including
-- its safety lesson: bound the OR-matched candidate set before ranking
-- (LIMIT 500) so a common-word OR-fallback can't blow the statement
-- timeout the way hybrid_search's first attempt did on content_chunks.
-- dictionary_terms is ~9,800 rows (vs. content_chunks' ~46,000 that
-- actually broke), so the real risk is lower here, but the cap is cheap
-- insurance against the exact failure class this codebase has already hit
-- once for a near-identical query shape.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  primary_count integer;
  or_count integer;
begin
  return query
    with words as (
      select regexp_replace(w, '[^a-zA-Z0-9]', '', 'g') as clean
      from regexp_split_to_table(trim(query), '\s+') as w
    ),
    filtered as (
      select clean from words where clean <> ''
    ),
    pq as (
      select to_tsquery('english', string_agg(clean || ':*', ' & ')) as tsq
      from filtered
    )
    select d.slug, d.term,
           case
             when d.category = 'mnemonic' then
               case when public.has_pro_access() then (d.senses->0->>'definition') else null end
             else
               case when public.has_plus_access() then (d.senses->0->>'definition') else null end
           end as definition,
           ts_rank(d.search_vector, pq.tsq) as out_rank
    from dictionary_terms d, pq
    where pq.tsq is not null
      and d.search_vector @@ pq.tsq
    order by
      (length(lower(d.term)) - length(replace(lower(d.term), lower(query), ''))) / greatest(length(query), 1) desc,
      out_rank desc
    limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);

  get diagnostics primary_count = row_count;
  if primary_count > 0 then
    return;
  end if;

  -- NEW middle tier: same (uncorrected) prefix terms, OR'd instead of
  -- AND'd. Only reachable when the strict-AND tier above found nothing.
  return query
    with words as (
      select regexp_replace(w, '[^a-zA-Z0-9]', '', 'g') as clean
      from regexp_split_to_table(trim(query), '\s+') as w
    ),
    filtered as (
      select clean from words where clean <> ''
    ),
    pq_or as (
      select to_tsquery('english', string_agg(clean || ':*', ' | ')) as tsq
      from filtered
    ),
    candidates as (
      select d.id
      from dictionary_terms d, pq_or
      where pq_or.tsq is not null and d.search_vector @@ pq_or.tsq
      limit 500
    )
    select d.slug, d.term,
           case
             when d.category = 'mnemonic' then
               case when public.has_pro_access() then (d.senses->0->>'definition') else null end
             else
               case when public.has_plus_access() then (d.senses->0->>'definition') else null end
           end as definition,
           ts_rank(d.search_vector, pq_or.tsq) as out_rank
    from dictionary_terms d
    join candidates c on c.id = d.id
    cross join pq_or
    order by out_rank desc
    limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);

  get diagnostics or_count = row_count;
  if or_count > 0 then
    return;
  end if;

  -- Last resort, unchanged: nothing matched as typed OR OR'd -- try
  -- correcting genuine misspellings (6+ char words only, so a short/valid
  -- prefix like "ima" never reaches here at all; it already returned real
  -- rows in the AND tier above).
  return query
    with corrected_words as (
      select coalesce(
        (select v.term from search_vocabulary v
          where length(w.clean) >= 6
            and abs(length(v.term) - length(w.clean)) <= 2
            and levenshtein(v.term, lower(w.clean)) <= 2
          order by levenshtein(v.term, lower(w.clean)), v.doc_freq desc
          limit 1),
        w.clean
      ) as clean
      from (
        select regexp_replace(x, '[^a-zA-Z0-9]', '', 'g') as clean
        from regexp_split_to_table(trim(query), '\s+') as x
      ) as w
      where w.clean <> ''
    ),
    pq2 as (
      select to_tsquery('english', string_agg(clean || ':*', ' & ')) as tsq
      from corrected_words
    )
    select d.slug, d.term,
           case
             when d.category = 'mnemonic' then
               case when public.has_pro_access() then (d.senses->0->>'definition') else null end
             else
               case when public.has_plus_access() then (d.senses->0->>'definition') else null end
           end as definition,
           ts_rank(d.search_vector, pq2.tsq) as out_rank
    from dictionary_terms d, pq2
    where pq2.tsq is not null
      and d.search_vector @@ pq2.tsq
    order by out_rank desc
    limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
end;
$function$;
