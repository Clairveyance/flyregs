-- Found 2026-08-19/20, full gating re-sweep -- the single most severe
-- finding of this round, worse than the pdf_url_cached column-grant leak
-- fixed earlier the same session: search_dictionary(), the RPC that powers
-- BOTH the Aviation Dictionary's own search bar (dictionary/index.tsx,
-- DictionarySearchBar.tsx) AND Home's federated SmartSearch (unifiedSearch.
-- ts's searchOtherSources(), includeDictionary defaults true), returns
-- `d.senses->0->>'definition'` completely unredacted, straight off the raw
-- dictionary_terms table, with ZERO has_plus_access()/has_pro_access()
-- check anywhere in the function body -- confirmed exploitable as fully
-- anonymous (no account, no session, nothing but the public anon key):
--   POST .../rpc/search_dictionary {"query":"tornado","result_limit":3}
--   -> 3 complete, untruncated real definitions (700+ chars each)
--
-- dictionary_terms_gated (the view every DETAIL screen reads through) has
-- correctly redacted `senses` via CASE since 2026-08-04/05
-- (gotcha_tier_gate_client_side_only.md) -- this RPC was simply never
-- brought into line with that fix, even though it reads the exact same
-- paid column from the exact same table.
--
-- unifiedSearch.ts's own comment (line ~106-109) claims "search_dictionary
-- still returns slug/term/rank for a gated caller, only `definition` nulls
-- out" -- that description was WRONG against the actual deployed function
-- (no such gate exists in the SQL), a stale assumption from whenever the
-- Dictionary re-gate work (2026-08-10, RC: "Plus gets the A/D, not the
-- Mnemonics. Pro also gets Mnemonics") was done at the view layer but
-- apparently never propagated to this RPC. The comment is left in place
-- (now true) since this migration makes it accurate rather than aspirational.
--
-- Fix: mirror dictionary_terms_gated's exact redaction shape --
-- category='mnemonic' requires has_pro_access(), everything else requires
-- has_plus_access(). Applied to BOTH the primary tsquery search and the
-- typo-correction fallback block (same bug, same missing gate, in both
-- halves of the function). search/browse metadata (slug, term, rank) stays
-- free -- unifiedSearch.ts's own comment already explains why a free
-- searcher should still SEE the term exists (leads to the whole-screen
-- Plus lock on tap), just not its actual paid content.

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
    limit result_limit;

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
    limit result_limit;
end;
$function$;
