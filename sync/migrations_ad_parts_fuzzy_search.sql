-- Fuzzy (typo-tolerant) fallback for parts-lookup search -- confirmed live
-- 2026-08-12 as a real gap while investigating RC's parts-search question:
-- searching "Lycomming" (one extra letter, a completely realistic typo)
-- returned "No parts found" even though "Lycoming" has 10+ real rows,
-- because searchParts()'s existing fallback chain (exact/substring match ->
-- drop-one-word retry -> common-language component-type family) has no
-- path at all for a single mistyped WORD -- the drop-one-word retry only
-- fires when there's more than one word, and a manufacturer typo isn't
-- common-English vocabulary the type-family bridge recognizes either.
--
-- pg_trgm (already enabled on this project, unused anywhere else in the
-- schema until now) gives real, cheap trigram-similarity fuzzy matching --
-- this is the LAST fallback in the chain (see src/lib/adParts.ts), only
-- ever tried after every literal-match strategy has already failed, same
-- "last resort, not first choice" posture as the component-type bridge
-- above it.
create extension if not exists pg_trgm;

create or replace function public.search_ad_parts_fuzzy(p_query text, p_limit int default 25)
returns table(id uuid, name text, component_type text, manufacturer text, best_similarity real)
language sql stable
as $$
  select p.id, p.name, p.component_type, p.manufacturer,
         greatest(similarity(p.name, p_query), coalesce(similarity(p.manufacturer, p_query), 0)) as best_similarity
  from public.ad_parts p
  where p.status = 'active'
    and (p.name % p_query or p.manufacturer % p_query)
  order by best_similarity desc
  limit p_limit;
$$;

grant execute on function public.search_ad_parts_fuzzy(text, int) to authenticated;
