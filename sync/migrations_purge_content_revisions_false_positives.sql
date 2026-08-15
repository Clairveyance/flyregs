-- Real data-quality bug found 2026-08-12 (RC + Claude): What's Changed
-- (src/app/whats-changed.tsx -> src/lib/whatsChanged.ts's getRevisions(),
-- last 100 content_revisions rows, no date filter) was showing dozens of
-- entries that were never real, recent FAA content changes -- confirmed by
-- pulling and reading the full added_text/removed_text for every affected
-- row (not sampling) and re-deriving the root cause for each doc_type
-- before deleting anything. Three unrelated bugs, three different fixes:
--
-- ============================================================
-- 1. PCG (3 rows, revised_at 2026-08-03 15:40:33 UTC)
-- ============================================================
-- sync/pcg_scraper.py's definition-extraction logic sliced full_text at
-- len(dfn_text), assuming the FAA's <dfn> tag always wraps the ENTIRE
-- visible term label. Confirmed live by fetching the real
-- glossary-a.html/glossary-g.html pages and reading the raw markup: for
-- these 3 terms the FAA's own </dfn> closes mid-parenthetical (e.g.
-- "<dfn>AUTOMATIC DEPENDENT SURVEILLANCE-BROADCAST IN (ADS</dfn>-B In)-
-- Aircraft avionics..."), so the leftover label fragment ("B In)-", "B
-- Out)-", "S), SPEED ADVISORY-") got glued onto the front of the newly
-- re-scraped definition. added_text minus that exact fragment is
-- byte-identical to removed_text in all 3 cases -- verified directly,
-- not assumed:
--   681ba42e (ADS-B In):  added="B In)- Aircraft avionics capable..." / removed="Aircraft avionics capable..." (same 168 chars)
--   7ea1926f (ADS-B Out): added="B Out)- The transmitter onboard..." / removed="The transmitter onboard..." (same 189 chars)
--   f91f57e7 (GIM-S):     added="S), SPEED ADVISORY- A calculated..." / removed="A calculated..." (same 114 chars)
-- Root cause fixed at the source in sync/pcg_scraper.py's
-- parse_letter_page() (2026-08-12 commit) -- extraction no longer trusts
-- the <dfn> boundary, instead finds the FAA's own term/definition
-- separator directly. A 4th term with the exact same corruption pattern
-- (AUTOMATIC DEPENDENT SURVEILLANCE, the base ADS-B entry) is currently
-- live in pcg_terms.definition -- it never showed up as a "revision"
-- because there was no clean prior version to diff against, so it isn't
-- deleted here (nothing to delete from content_revisions), but it's a
-- real live data-quality issue self-healed by the next real `pcg_scraper.py
-- --mode full` run now that the extraction bug is fixed.
--
-- ============================================================
-- 2. AIM (1 row, revised_at 2026-08-10 11:50:48 UTC, AIM 3-1-4)
-- ============================================================
-- A table renumber (TBL 3-1-1 -> TBL 3-1-4, already correctly suppressed
-- by revision_log.py's existing TBL/FIG label-prefix strip from commit
-- f41da2e) bundled with a pure reformat of the SAME unchanged cell
-- content: a row header like "Class E:" followed by a real newline and
-- its sub-row on the next line in one extraction pass became "Class E ; "
-- (colon swapped for a semicolon, newline collapsed to a space) joined
-- onto one line in the other pass, plus 2 spots where a row-ending period
-- appeared/disappeared right at the same collapsed-newline boundary
-- ("...10,000 feet MSL" vs "...10,000 feet MSL."). Manually diffed
-- character-by-character after stripping the TBL label: every number,
-- every word, every row of the table is identical on both sides -- zero
-- substantive change, 100% reformat noise. revision_log.py's
-- _normalize_for_diff() (2026-08-12 commit) now also collapses whitespace
-- runs and treats ":"/";" as equivalent at a clause boundary, plus drops
-- a bare "." immediately before whitespace -- verified this exact
-- ac10652f pair normalizes to byte-identical text under the new logic,
-- and that it does NOT erase the genuine FAR 36.1501 MOSAIC content
-- change (see item 3 below) or the existing TBL-renumber suppression.
--
-- ============================================================
-- 3. AD (72 rows, revised_at 2026-08-06 01:34:13 - 04:50:14 UTC)
-- ============================================================
-- NOT scraper text-extraction noise like items 1-2 -- pulled and read the
-- full added_text/removed_text for all 72 rows (35 distinct ad_number
-- keys, some appearing 2-4x) and confirmed a different, more specific
-- mechanism: sync/ad_scraper.py's AD_HEADER_RE captures only the
-- "YYYY-NN-NN" prefix of an AD's own number, silently dropping any " R1"/
-- " R2" revision suffix or missing that a "Final rule; correction" notice
-- merely cites an older AD's number rather than being that AD's real
-- text. Two concrete, confirmed collision patterns, both real FAA
-- documents on both sides (not extraction jitter of one document):
--   (a) A base AD and its own later revision share one ad_number, e.g.
--       "2000-25-02" (base, Amendment 39-12036) vs "2000-25-02 R1"
--       (Amendment 39-12255, a genuine later FAA revision that legally
--       supersedes the base) -- both parse to the SAME key.
--   (b) Two textually unrelated ADs the FAA itself assigned the same
--       number, e.g. "2023-12-09" is BOTH Airbus Canada (Amendment
--       39-22467, flight-control-system AD) AND The Boeing Company
--       (Amendment 39-22773, wing/drag-fitting AD) -- confirmed by
--       reading each one's own full text, both genuinely printed as
--       "2023-12-09" in their respective Federal Register final rules.
-- On 2026-08-06, a manual, ad-hoc `ad_scraper.py --mode full` run
-- (backfilling the newly-added effective_date column across the whole AD
-- corpus per commit 927fd34, re-running once more after the same-day NUL-
-- byte fix in ac635774) iterated the full corpus newest-year-first
-- (iter_years_full()) and, for every one of these 35 colliding keys,
-- upserted first one real document's text under the shared key and then
-- the other, each write correctly triggering log_revisions() against
-- whatever the other write had just stored -- 100% real content on both
-- sides of every diff, 0% a genuine "the FAA changed this AD this week"
-- event (every affected AD's actual text dates from 2000-2023). Confirmed
-- for all 72 rows, not sampled: every added_text/removed_text pair
-- contains two DIFFERENT real "Amendment XX-XXXXX" citations (checked
-- programmatically) except 3 rows (2005-01-04 singleton, 2015-25-08 x2)
-- where the SAME amendment number appears on both sides -- those are a
-- Federal Register "[Corrected]"/technical-correction notice restating an
-- unchanged effective date and model list with only wording/punctuation
-- differing from the base AD text, same net verdict (noise, not a real
-- requirement change).
-- NOTE: this purge only cleans the What's Changed timeline. The
-- underlying ad_number collision is a separate, real, currently-live data
-- bug -- airworthiness_directives.ad_number is not a safe unique key, so
-- one of each colliding pair's text is currently either stale (a
-- superseded original overwriting its own governing revision, case (a))
-- or entirely missing from the table (case (b), e.g. the Boeing 757
-- wing/drag-fitting AD is not stored under "2023-12-09" right now -- only
-- the unrelated Airbus Canada AD is). Deliberately NOT fixed in this
-- migration -- it needs its own dedicated ad_scraper.py change (preserve
-- the R1/R2 suffix, and/or a compound key) plus a corpus-wide audit of
-- which ad_numbers are currently affected, flagged separately.
--
-- Every id below was individually verified against its full stored text
-- before being included -- this is not a pattern-match/broad delete.
-- Expected result: content_revisions drops from ad=72/aim=1/far=16/pcg=3
-- (ac=0) to ad=0/aim=0/far=16/pcg=0 -- 76 rows removed, the 16 far rows
-- (genuine MOSAIC-era regulatory text changes, spot-checked at
-- §36.1501 specifically per RC's request -- a real, substantive rewrite
-- splitting one requirement into type-certificated vs. non-type-
-- certificated aircraft, not noise) left untouched.

-- ---- PCG (3 rows) ----
DELETE FROM content_revisions WHERE id IN (
  '681ba42e-b1bd-4fc6-b850-d16045e791aa',
  '7ea1926f-4df7-4988-b4a3-cb454bd6a4c9',
  'f91f57e7-5e40-46fa-820e-210204ea33d2'
);

-- ---- AIM (1 row) ----
DELETE FROM content_revisions WHERE id IN (
  'ac10652f-b912-461b-a83e-b77486c0f125'
);

-- ---- AD (72 rows) ----
DELETE FROM content_revisions WHERE id IN (
  '01288073-662c-486b-ae25-c6da71d948d4', '08f930db-abbf-4208-aa0d-dd9fd381d76a', '0af16239-f957-47c1-b50b-9151d99ec3b0', '1b27f917-dee3-4f59-9a7d-c9b500b84e86',
  '1b942e78-e5a8-4eb5-8042-ef140fc3cfe5', '1c594e5b-8bd8-4691-b30f-8e8b97756bca', '230218e4-93fd-49d6-b43d-0cab899d4aa7', '231eca35-6233-4bf5-bf46-196d8fcad808',
  '24fe39af-80a5-44a6-bf14-039187a1066c', '29ca7223-fedf-4cac-b2d6-dfda4bef7312', '2aae1334-7225-4491-b347-74e52027bfd1', '2b0dac27-a048-4123-a1ce-ee7474ccf6ac',
  '2b70681d-c140-414a-8f7d-5f113358ff24', '2e7d5a73-396f-4d9c-90db-844f8b6abeaf', '315a187e-1b08-45dd-b172-8ed009ea1665', '372c0275-9ff1-4d67-9441-6e434d2980e8',
  '3aedf3b9-14a7-4ca8-9adb-7ac48b2de616', '3df880e1-6744-435f-b59a-934b324a34ab', '3e952eff-4a76-4bfb-913d-cc6b77c8bccf', '402289e2-4749-4333-97f6-f6c7dd78f204',
  '44b19bda-630e-4a59-8f2c-0bc6f09edf98', '45fe2383-1e63-4d9f-a907-d1a8fe0b0427', '467f81df-37fa-4c7b-afca-564122a7e106', '4d292d30-332c-46ea-97de-d1c1877ba4ba',
  '4e286488-f76e-445a-b6de-20c941a6470a', '51a88a8a-868e-44a1-94c8-043f92bcb8e2', '5464451a-304e-4545-9ccb-5f406b118649', '5fa6bd9a-dd11-49b9-9317-d13b0afd55b9',
  '66fe65dd-7fd3-48f8-a37e-a918697c49da', '6b902973-4c8d-4b82-92cd-48c956f7f453', '6c77e16a-1a99-4c69-aaaa-ed6aa3d5ce4e', '7182e127-1f96-47fe-aa4e-aa114adb70c0',
  '7216b7ff-8b6c-4da7-aec8-0b957409650a', '74f0c67b-8204-4e16-a8d1-fadb2be7c63b', '76b59b1f-0eb6-46f3-98b6-dd38656b91e3', '78da94b0-66ec-4ffa-85ec-04de6899532c',
  '7a520025-53d0-4a4e-b83d-b9a9fd8d4c77', '7bb42900-383b-42d3-84b1-8cc4ebd3f372', '7beb5a4d-4ac0-497a-994e-c071e44ecdf6', '7c311d15-a5c2-4b7d-85d5-60c70e094c80',
  '7d527b61-e57e-4dc1-8d5c-02a5c713311f', '7e7c01ed-eadb-48a4-8875-81638e0d5e60', '7fa3af80-29be-424a-9a80-71ad6315c6cf', '8def3cf4-901e-48c4-8ccc-4fc4e5b8b626',
  '8f6a446e-3899-4b0b-b14c-7df7e6dbcf37', '910d5727-9a25-4e44-b554-e37e345c9f65', '91699736-2c48-4c91-a2a5-1b72213b0819', '943c11f0-2aa5-49b1-94f9-8a22276c232e',
  '9887b365-c9b1-4844-9367-1873e8b2b173', '9fb8542d-2c58-4307-b2e0-9cc563a206d6', 'a06e1884-057c-4f9f-8210-8f89d60185c5', 'a7a64b66-c5ed-4451-9c9a-e43599d1467f',
  'ae3eb0c8-ce60-4623-87a9-57170f942027', 'af8329c1-f540-4f74-9224-d12436e02a1c', 'b8b74daa-855a-4571-99c5-d318119b85de', 'bb1c39df-962b-4523-96b0-6f61f0691c12',
  'bc757e51-c5bc-4b52-942b-14857524232d', 'bdc1392c-9d2b-415d-b09b-a393e92a936b', 'c3afc88b-a1cc-4529-8f16-a09fb1ddd2da', 'c61c3436-e6e3-47d6-9ed3-65895edd0321',
  'c8bd1b1e-af98-4da9-b828-e1163a9b0d27', 'cb79cad7-cdf1-4a10-99f4-f76e699160bb', 'ccb5cf86-9758-4735-97e5-531f5f01ef74', 'd8081a93-ba11-43fc-8b1f-24c9e32f3413',
  'd9503608-6a55-48d6-8826-317f2898240e', 'e0d61f14-97d5-4532-be67-038b44a232cf', 'e8d7f0e9-1f49-4b6e-83d0-2b3ce221c2cb', 'e9937626-0d1c-4730-aef1-da7baaba83bd',
  'f8e4a781-3c9a-479c-8e6f-41b12f985fba', 'fa2ca9d6-063c-4043-a094-1692cf3c1296', 'fd172d96-dc8e-4889-9b93-42046b6293a4', 'fee40574-91ed-41ce-b43a-a5855e9787ad'
);
