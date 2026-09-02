-- Rank the dictionary OR tier before truncating it (2026-09-03)
--
-- Found by the overnight search audit, verified live before changing anything.
-- Only the `candidates` CTE changes; the rest of the function is byte-identical
-- to what was running.

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
      -- ORDER BY added 2026-09-03. `limit 500` with no ordering discarded
      -- candidates ARBITRARILY, before any ranking happened, and which 500
      -- survived was whatever the planner happened to emit. Measured live on
      -- "supplemental oxygen cabin pressure altitude requirement": 938
      -- candidates, 438 thrown away unranked, and the single best-matching
      -- term in the entire corpus ("Pressure-demand oxygen system",
      -- ts_rank 0.0529) was among the ones that could vanish.
      order by ts_rank(d.search_vector, pq_or.tsq) desc
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
$function$

