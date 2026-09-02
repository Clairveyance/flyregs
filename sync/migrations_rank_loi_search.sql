-- search_legal_interpretations had no relevance ranking at all (2026-09-03)
--
-- It ordered purely by `l.year desc, l.slug`. For "flight review" -- 178 LOIs
-- match -- the five most relevant are:
--     0.9948  levy-2008
--     0.9735  newman-2015
--     0.9406  bennett-southern-california-soaring-academy-2016
--     0.6863  rescinded-schaffner-legal-interpretation-2014
--     0.6769  borella-2012
-- and NOT ONE of them appeared in what the function returned. A free user
-- (capped at 10 of 178) got the five newest LOIs instead, none of which is
-- about flight reviews.
--
-- This matters more than the LOI screen alone: search_legal_interpretations was
-- wired into SmartSearch on 2026-08-31, and unifiedSearch.ts synthesises its
-- rank as `length - i` from THIS order -- so the newest matching LOI normalises
-- to 1.0 and ties the best FAR result in the merged list.
--
-- Also escapes the LIKE. `l.title ilike '%' || q || '%'` treated user input as a
-- pattern: q='%' returned 10 rows with zero tsquery matches. "100%" is a
-- plausible real query.
--
-- Year is KEPT as the tiebreak, so recency still decides between equally
-- relevant interpretations -- which is the right default for legal
-- interpretations, and was presumably the intent behind the original ordering.

begin;

create or replace function public.search_legal_interpretations(q text, lim integer default 50)
returns table(slug text, title text, addressee text, year integer, summary text, cfr_part_reference text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select l.slug, l.title, l.addressee, l.year, l.summary, l.cfr_part_reference
  from legal_interpretations l
  where q is null or btrim(q) = ''
     or l.search_vector @@ plainto_tsquery('english', q)
     or l.title ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by
    case when q is null or btrim(q) = '' then 0::real
    else
      ts_rank(l.search_vector, plainto_tsquery('english', q))
      + case when l.title ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
             then 1 else 0 end
    end desc,
    l.year desc nulls last,
    l.slug
  limit (case when public.has_plus_access() then least(coalesce(lim, 50), 200) else least(coalesce(lim, 50), 10) end);
$function$;

commit;
