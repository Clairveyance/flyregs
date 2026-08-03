-- Aviation Dictionary search was whole-word-only (plainto_tsquery), so a
-- partial/prefix query like "ima" matched nothing at all -- RC: "our SS
-- here should be starting to populate results as a user types. here, it
-- should be giving me things like IMAIR as a result already. i shouldn't
-- have to be word perfect."
--
-- Switches to a prefix tsquery (each cleaned word gets a trailing :*).
-- Uses the same 'english' config the generated search_vector column itself
-- uses (to_tsvector('english', term || ' ' || definitions)), so a real
-- English word's stemmed prefix still matches correctly -- this is a
-- strict superset of the old whole-word behavior, not a replacement of it.
-- Input is sanitized to [a-zA-Z0-9] per word before ever reaching
-- to_tsquery, so arbitrary user input can't produce a tsquery syntax error
-- (to_tsquery, unlike plainto_tsquery, parses its input as a query
-- language and would otherwise throw on stray &, |, (, ), : characters).
--
-- Same RPC also powers DictionarySearchBar.tsx (pinned A/D search bar) and
-- Home's federated SmartSearch (unifiedSearch.ts) -- both already gate on
-- a 2-character minimum before calling, so no caller-side change needed.
create or replace function public.search_dictionary(query text, result_limit integer default 20)
returns table(slug text, term text, definition text, out_rank real)
language sql
stable
as $function$
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
$function$;
