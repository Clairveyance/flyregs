-- search_legal_interpretations: use the stored tsvector (2026-09-01)
--
-- A regression I introduced on 2026-08-31 when wiring LOI into SmartSearch.
-- This is the ONLY search RPC in the corpus that computes its tsvector inline
-- instead of using its stored one -- checked every function in `public`:
--
--     or to_tsvector('english', coalesce(l.body_text, '')) @@ plainto_tsquery(...)
--
-- legal_interpretations is 1,059 rows / ~15 MB of body_text, so every call
-- re-tokenised all 15 MB. Measured wall-clock, same query, same conditions:
--
--     search_pcg   712 ms      search_aim   740 ms
--     search_acs   802 ms      search_far   844 ms
--     search_legal_interpretations        2139 ms   <- ~1.4s slower than any sibling
--
-- pg_stat_statements agrees on the real client path: mean 1112 ms over 281
-- calls, 312 s total -- the 4th-largest total time in the database.
--
-- Why it slowed the WHOLE app, not just LOI: searchOtherSources wraps all 8
-- sources in one Promise.all, so results cannot render until the slowest
-- returns -- every Home search waited on this regardless of how fast FAR/AIM/
-- P-CG answered. And runSearch calls searchOtherSources once per search term
-- (literal + up to 6 expansions), so a single search could fire SEVEN
-- concurrent sequential scans of a 15 MB table. This is very likely a real
-- part of RC's "everything in the app is taking WAY TOO LONG to open."
--
-- The table already HAS the right thing: a STORED generated search_vector
-- (summary A / addressee+cfr refs B / title B / body_text C), 0 nulls, backed
-- by a GIN index. The function simply never used it.
--
-- Correctness checked before applying, not assumed -- current vs rewritten
-- result counts over 7 real queries: night currency 3/3, flight review
-- 178/178, logging pic 41/41, part 135 294/335, medical 61/61, hangar 16/16,
-- tailwheel 2/2. LOST = 0 in every case. A strict superset: "part 135" gains
-- 41 correct extra hits from the summary/cfr_part_reference weights the stored
-- vector already carries.
--
-- The `title ilike` clause is deliberately KEPT -- dropping it would lose
-- substring title matches the FTS tokeniser does not produce.
--
-- Body taken verbatim from live pg_get_functiondef; one line changed.

begin;

CREATE OR REPLACE FUNCTION public.search_legal_interpretations(q text, lim integer DEFAULT 50)
 RETURNS TABLE(slug text, title text, addressee text, year integer, summary text, cfr_part_reference text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select l.slug, l.title, l.addressee, l.year, l.summary, l.cfr_part_reference
  from legal_interpretations l
  where q is null or btrim(q) = ''
     or l.search_vector @@ plainto_tsquery('english', q)
     or l.title ilike '%' || q || '%'
  order by l.year desc nulls last, l.slug
  limit (case when public.has_plus_access() then least(coalesce(lim, 50), 200) else least(coalesce(lim, 50), 10) end);
$function$
;

commit;
