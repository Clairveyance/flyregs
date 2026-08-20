-- Aviation Dictionary search: typo tolerance, not just prefix    2026-08-19
--
-- RC: "make Dict search smart. fuzzy. typos, etc. needs to be easy to find
-- things. helpful." migrations_dictionary_prefix_search.sql already fixed
-- the PARTIAL-word case ("ima" -> IMAIR/IMAP) via a prefix tsquery, but a
-- genuine misspelling ("altimter", "transpodner") still matches nothing
-- at all -- to_tsquery has no notion of "close to a real word."
--
-- FIRST ATTEMPT, reverted before shipping: routing every query through
-- SmartSearch's existing search_resolve_query() (migrations_search_
-- tolerance.sql). Tested live and found a real regression: that function's
-- PREFIX branch resolves "ima" to "imagery" (the most common real corpus
-- word starting with "ima", by doc_freq) and REPLACES "ima" with it before
-- the tsquery ever runs -- so instead of matching every word starting with
-- "ima" (IMAIR, IMAP, imagery...), it only matched the single word
-- "imagery", losing IMAIR/IMAP entirely. That prefix-resolution behavior
-- is correct for SmartSearch (one best-guess replacement word), but wrong
-- for Dictionary, which already has a BETTER native prefix mechanism (the
-- tsquery `:*` suffix matches every real completion, not just one guess).
--
-- Fix: two-tier, not a blanket rewrite. Run the query exactly as before
-- first (byte-for-byte the same prefix-tsquery logic as the existing
-- function -- a query that already works today is GUARANTEED to keep
-- working identically). Only if that returns zero rows, retry with each
-- word individually corrected via the SAME fuzzy-only threshold
-- search_resolve_term() already validated (6+ chars, edit distance <= 2,
-- similar length -- see that function's own comment for the real
-- drunk/drug false-positive research behind those numbers), skipping its
-- prefix branch entirely by only ever reaching for a word 6+ characters
-- long, where prefix-vs-fuzzy ambiguity isn't a concern the same way.
-- SECURITY DEFINER + SET search_path is load-bearing, not decoration --
-- authenticated/anon have no SELECT grant on dictionary_terms directly
-- (locked down 2026-08-06's tier-gating hardening pass forces reads
-- through dictionary_terms_gated instead; see gotcha_search_ads_
-- dictionary_permission_denied). This function's own SELECT list already
-- only returns safe preview columns (slug/term/definition), same
-- justification as that original fix. CREATE OR REPLACE does NOT retain
-- SECURITY DEFINER/SET search_path from a prior definition unless
-- re-specified here -- omitting this line is exactly what silently
-- regressed dictionary search to a 403 for every real user when this
-- file's typo-tolerance rewrite first shipped 2026-08-19, undetected
-- because live-testing at the time went through a service-role path that
-- bypasses table grants rather than a real anon-key+authenticated-JWT
-- call. Keep this every time this function is touched again.
create or replace function public.search_dictionary(query text, result_limit integer default 20)
returns table(slug text, term text, definition text, out_rank real)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
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
           (d.senses->0->>'definition') as definition,
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
           (d.senses->0->>'definition') as definition,
           ts_rank(d.search_vector, pq2.tsq) as out_rank
    from dictionary_terms d, pq2
    where pq2.tsq is not null
      and d.search_vector @@ pq2.tsq
    order by out_rank desc
    limit result_limit;
end;
$function$;
