-- Real, live-confirmed gap found and re-confirmed during the B34 content
-- functional-test agent's re-run: search_legal_interpretations (LOI
-- search) never got the 2026-08-11 depth-gating sweep's fix -- every
-- other content-search RPC (search_far/aim/pcg/ads/cfr49/dictionary/acs)
-- caps non-Plus callers at <=10 results; this one still returns the full
-- requested limit (up to 200) to every tier including anon. Live-
-- confirmed: anon/free/plus/pro/premium all got 200/200 results for the
-- same query before this fix.
--
-- Fix: same exact pattern every sibling search RPC already uses (see
-- search_ads), applied here for consistency -- no signature change, safe
-- as CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.search_legal_interpretations(q text, lim integer DEFAULT 50)
 RETURNS TABLE(slug text, title text, addressee text, year integer, summary text, cfr_part_reference text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select l.slug, l.title, l.addressee, l.year, l.summary, l.cfr_part_reference
  from legal_interpretations l
  where q is null or btrim(q) = ''
     or to_tsvector('english', coalesce(l.body_text, '')) @@ plainto_tsquery('english', q)
     or l.title ilike '%' || q || '%'
  order by l.year desc nulls last, l.slug
  limit (case when public.has_plus_access() then least(coalesce(lim, 50), 200) else least(coalesce(lim, 50), 10) end);
$function$;
