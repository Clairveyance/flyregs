-- Real data-quality bug found 2026-08-12 (RC + Claude), same root cause as
-- the 3 content_revisions false positives purged the same day (see
-- sync/migrations_purge_content_revisions_false_positives.sql for the full
-- writeup): sync/pcg_scraper.py's old definition-extraction logic sliced
-- full_text at len(dfn_text), assuming the FAA's <dfn> tag always wraps
-- the entire visible term label. For a handful of terms the FAA's own
-- </dfn> closes mid-parenthetical instead (confirmed by fetching the real
-- glossary-a.html/glossary-g.html pages and reading the raw markup
-- directly), so a fragment of the term's own label got glued onto the
-- front of the stored definition.
--
-- 3 of the 4 affected terms had a clean prior version in the DB to diff
-- against, so the bug surfaced as a "revision" and got caught/purged from
-- content_revisions. This 4th one (AUTOMATIC DEPENDENT SURVEILLANCE, the
-- base ADS-B glossary entry -- distinct from the IN/OUT variants) has
-- apparently been corrupted this way since it was first scraped, so
-- old==new on every subsequent re-scrape and log_revisions() never had
-- anything to flag. Its corrupted definition is live in pcg_terms right
-- now, independent of and not touched by the content_revisions purge
-- above (that migration only deletes from content_revisions, never
-- touches pcg_terms).
--
-- Corrected text for all 4 verified two independent ways: (1) running the
-- FIXED parse_letter_page() (sync/pcg_scraper.py, same 2026-08-12 commit)
-- directly against the real glossary-a.html/glossary-g.html pages fetched
-- fresh from faa.gov, no DB involved; (2) a from-scratch standalone
-- re-implementation of the same fix, cross-checked against (1) -- both
-- agree exactly. Applied here as direct UPDATEs (not a live
-- `pcg_scraper.py --mode full` re-scrape) specifically so this narrow,
-- already-verified repair doesn't also touch the other 1,328 unaffected
-- PCG terms or write any new content_revisions rows for a change that's
-- really "our own extraction bug getting fixed," not a genuine FAA edit.
-- `term` is left as-is (still missing the trailing "-BROADCAST (ADS-B)" /
-- "-BROADCAST IN (ADS-B In)" / "-BROADCAST OUT (ADS-B Out)" / "-SPACING
-- (GIM-S)" suffix on these 4 rows) -- that's a related but separate,
-- smaller truncation in the same split-<dfn>-boundary terms, deliberately
-- not fixed here (see this session's report for why).

UPDATE pcg_terms
SET definition = 'A surveillance system in which an aircraft or vehicle to be detected is fitted with cooperative equipment in the form of a data link transmitter. The aircraft or vehicle periodically broadcasts its GNSS-derived position and other required information such as identity and velocity, which is then received by a ground-based or space-based receiver for processing and display at an air traffic control facility, as well as by suitably equipped aircraft.'
WHERE slug = 'AUTOMATIC_DEPENDENT_SURVEILLANCE';

UPDATE pcg_terms
SET definition = 'Aircraft avionics capable of receiving ADS-B Out transmissions directly from other aircraft, as well as traffic or weather information transmitted from ground stations.'
WHERE slug = 'AUTOMATIC_DEPENDENT_SURVEILLANCE_BROADCAST_IN_ADS';

UPDATE pcg_terms
SET definition = 'The transmitter onboard an aircraft or ground vehicle that periodically broadcasts its GNSS-derived position along with other required information, such as identity, altitude, and velocity.'
WHERE slug = 'AUTOMATIC_DEPENDENT_SURVEILLANCE_BROADCAST_OUT_ADS';

UPDATE pcg_terms
SET definition = 'A calculated speed that will allow aircraft to meet the TBFM schedule at en route and TRACON boundary meter fixes.'
WHERE slug = 'GROUND_BASED_INTERVAL_MANAGEMENT_SPACING_GIM';
