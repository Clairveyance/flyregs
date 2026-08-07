-- search_dictionary had two prior fixes never recommitted to a migration
-- file (see gotcha_migration_files_drift_from_live_db.md) -- the committed
-- sync/migrations_dictionary_prefix_search.sql predates both and no longer
-- matches what's deployed. This file captures the FULL current live body,
-- not a diff, so it stops drifting further.
--
-- History, in order:
-- 1. Prefix search (old, in migrations_dictionary_prefix_search.sql) --
--    switched plainto_tsquery to a prefix tsquery so partial words like
--    "ima" could match IMAIR while typing.
-- 2. Contraction fix (applied live, never committed) -- tokenizing via
--    hand-split + strip-punctuation turned "I'm" into the literal token
--    "im", which never exists in any real tsvector (Postgres splits "I'm"
--    into "i"+"m", dropping "i" as a stopword), so any query with a
--    contraction silently matched nothing. Switched to tokenizing via
--    to_tsquery('english', query) directly (the same pass that built the
--    indexed search_vector column), added an AND/OR fallback pattern
--    mirroring search_far's, and dropped 1-2 character lexemes (mostly
--    contraction debris) before building either tsquery.
-- 3. Relevance floor on the OR fallback (this change) -- RC, real device:
--    a junk/low-signal query ("what do i do if i can't reach the tower",
--    or outright nonsense) surfaced near-random top results on this
--    screen. Unlike unifiedSearch.ts's federated view (where a weak
--    dictionary hit gets correctly outranked by a real far/aim/pcg match),
--    the Dictionary's own search screens have nothing else to compare
--    against, so a single stray lexeme match out of a 6+ word query was
--    good enough to become the #1 result. Now the OR fallback requires at
--    least half the query's real distinct content words to match
--    (rounding up) before accepting a row, unless the query only HAS 1-2
--    real content words to begin with (n_lex <= 2), in which case a
--    genuine single-term search like "squawk" still works standalone. An
--    absolute ts_rank cutoff was considered and rejected: ts_rank's scale
--    isn't comparable across rows of different length/structure, so a
--    fixed threshold would be fragile in a way a proportional match-count
--    isn't.
create or replace function public.search_dictionary(query text, result_limit integer default 20)
returns table(slug text, term text, definition text, out_rank real)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with lexemes as (
    select (m)[1] as clean
    from regexp_matches(to_tsvector('english', query)::text, $$'([^']+)'$$, 'g') as m
  ),
  filtered as (
    select distinct clean from lexemes where length(clean) >= 3
  ),
  pq as (
    select
      to_tsquery('english', string_agg(clean || ':*', ' & ')) as and_q,
      to_tsquery('english', string_agg(clean || ':*', ' | ')) as or_q,
      count(*) as n_lex
    from filtered
  ),
  hits as (
    select d.slug, d.term, (d.senses->0->>'definition') as definition,
           ts_rank(d.search_vector, pq.and_q) as out_rank
    from dictionary_terms d, pq
    where pq.and_q is not null and d.search_vector @@ pq.and_q
  ),
  fallback as (
    select d.slug, d.term, (d.senses->0->>'definition') as definition,
           ts_rank(d.search_vector, pq.or_q) as out_rank
    from dictionary_terms d, pq
    where pq.or_q is not null
      and d.search_vector @@ pq.or_q
      and not exists (select 1 from hits)
      and (
        pq.n_lex <= 2
        or (
          select count(*) from filtered f
          where d.search_vector @@ to_tsquery('english', f.clean || ':*')
        ) >= ceil(pq.n_lex / 2.0)
      )
  )
  select x.slug, x.term, x.definition, x.out_rank
  from (select * from hits union all select * from fallback) x
  order by
    (length(lower(x.term)) - length(replace(lower(x.term), lower(query), ''))) / greatest(length(query), 1) desc,
    x.out_rank desc
  limit result_limit;
$function$;
