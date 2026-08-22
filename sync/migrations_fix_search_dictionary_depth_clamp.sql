-- Fixes P2-2 from the 2026-08-22 gating audit: search_dictionary had no
-- Plus depth clamp at all -- confirmed live, a FREE account with
-- result_limit=50 got 50 raw rows back (definition redaction was correct;
-- result DEPTH was not). Every sibling search function (search_far,
-- search_aim, search_cfr49, search_pcg, search_acs, search_ads,
-- search_legal_interpretations, search_figures) clamps non-Plus callers
-- to 10 via the same `limit (case when has_plus_access() then
-- result_limit else least(result_limit, 10) end)` pattern -- this brings
-- search_dictionary in line with the exact same convention on both its
-- primary and misspelling-fallback queries. Live-verified: anon +
-- result_limit=50 now returns 10.
CREATE OR REPLACE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  primary_count integer;
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

  -- Fallback: nothing matched as typed -- try correcting genuine
  -- misspellings (6+ char words only, so a short/valid prefix like "ima"
  -- never reaches here at all; it already returned real rows above).
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
