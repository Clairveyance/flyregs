-- 14 CFR 93.101/93.103 (Part 93 Subpart H, the NY North Shore Helicopter
-- Route rule) expired 2026-07-29 by its own stated sunset clause ("between
-- July 29, 2022, and July 29, 2026"). Independently confirmed live against
-- eCFR's own current-version XML (the same endpoint far_scraper.py itself
-- calls): Part 93 now reads "Subparts H-I [Reserved]" -- the rule is gone
-- from the actual CFR, not just old in our copy. far_scraper.py has no
-- delete/reconciliation logic at all (confirmed by reading the whole file)
-- -- unlike faa_scraper.py's mark_cancelled_acs(), nothing here ever
-- removes a section eCFR stops publishing, so these 2 rows sat serving as
-- "current law" for 12 days past their own real expiration, reachable by
-- 3 real MagicLink citations from Legal Interpretations that discuss this
-- (now-historical) rule.
--
-- Found in the post-build-31 sweep's data-correctness pass ("Data Is King"
-- -- this is about as serious as a data-accuracy bug gets for this app).
--
-- The LOI documents themselves stay (they're genuine historical legal
-- interpretations, still real and citable as history) -- only the dead
-- MagicLink citations TO the now-nonexistent sections are removed, since a
-- citation pointing at nothing is worse than no citation (dead-ends
-- instead of just not being offered).
DELETE FROM document_citations
WHERE (cited_type = 'far' AND cited_id IN ('93.101', '93.103'))
   OR (citing_type = 'far' AND citing_id IN ('93.101', '93.103'));

DELETE FROM far_sections WHERE section_number IN ('93.101', '93.103');
