-- Revert far_parts.sort_order to plain ascending numeric Part order   2026-08-24
--
-- RC, real user (Robin) bug report, screenshot of the FAR Parts browse list
-- showing 91, 61, 107, 43, 67, 121... instead of ascending order: "the
-- relevance score isn't for our reg lists, it's for our search engines. all
-- the static lists should be numerical like they always have been. The SS
-- feature, when it gives results, THAT'S what should be sorting by
-- objective relevance based on use and 'popularity'. Fix it."
--
-- migrations_far_parts_importance_order.sql (2026-08-20 AM) and
-- migrations_far_parts_live_priority_algorithm.sql (2026-08-20 PM, the one
-- actually live) both replaced far_parts' plain numeric order with a
-- relevance-driven one -- correct instinct for SEARCH RESULT ranking, wrong
-- table: far_parts.sort_order drives the static FAR-by-Part BROWSE list
-- (far/index.tsx) and the FAR-part filter dropdown (get_far_parts()), which
-- both a pilot's existing mental model ("Part 91, Part 61...") and RC's own
-- directive here say must stay plain ascending numeric, same as every other
-- static browse list in the app (AC series, AD, etc.) always has been.
-- Relevance/popularity signal stays exactly where it already correctly
-- lives -- SmartSearch ranking (search_popularity feeds hybrid_search,
-- search_dictionary, etc. directly; untouched by this migration).
--
-- All 83 far_parts.part values are plain digit strings (confirmed live, no
-- letter suffixes), so a numeric cast is an unambiguous, correct sort key.

UPDATE public.far_parts fp
SET sort_order = ranked.rnk
FROM (
  SELECT part, row_number() OVER (ORDER BY part::int) - 1 AS rnk
  FROM public.far_parts
) ranked
WHERE ranked.part = fp.part;

-- Stop the daily cron (refresh_search_popularity, 08:17 UTC) from ever
-- re-deriving sort_order from the relevance score again, and drop the
-- function that did it -- it had no other purpose or caller (confirmed:
-- only referenced from refresh_search_popularity's own body and the one
-- pg_cron job that calls it).
CREATE OR REPLACE FUNCTION public.refresh_search_popularity()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE advisory_circulars SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE far_sections SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE aim_paragraphs SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE pcg_terms SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE cfr49_sections SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE airworthiness_directives SET search_popularity = 0 WHERE search_popularity <> 0;
  UPDATE legal_interpretations SET search_popularity = 0 WHERE search_popularity <> 0;

  UPDATE advisory_circulars a SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'ac' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = a.document_number;

  UPDATE far_sections f SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'far' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = f.section_number;

  UPDATE aim_paragraphs p SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'aim' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = p.paragraph_number;

  UPDATE pcg_terms t SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'pcg' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = t.slug;

  UPDATE cfr49_sections f SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'cfr49' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = f.section_number;

  UPDATE airworthiness_directives ad SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'ad' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = ad.ad_number;

  UPDATE legal_interpretations l SET search_popularity = c.n
  FROM (SELECT doc_id, count(*) AS n FROM search_click_log WHERE doc_type = 'loi' AND created_at > now() - interval '90 days' GROUP BY doc_id) c
  WHERE c.doc_id = l.slug;

  -- No longer chains to refresh_far_parts_priority() -- see this file's
  -- header comment. search_popularity itself is untouched and keeps
  -- feeding SmartSearch ranking exactly as before.
END;
$function$;

DROP FUNCTION IF EXISTS public.refresh_far_parts_priority();
