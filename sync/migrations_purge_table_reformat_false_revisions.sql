-- Purge 121 false "changed" entries caused by our own table re-scrape (2026-09-01)
--
-- RC: "it's showing 100 AIM docs as 'changed' but it clearly [is] not accurate
-- for the things that are in there. there is a big gap in how that function is
-- working."
--
-- He is right, and the cause is our own work, not the FAA's. On 2026-08-31 the
-- colspan/rowspan fix (sync/table_grid.py) plus mergeHeaderRows() re-rendered
-- every table in the corpus. revision_log.py compared the new body_text against
-- the old, saw a difference, and logged a "revision" for 121 documents
-- (93 far / 23 aim / 5 cfr49) on a single day. Not one of them is an FAA
-- amendment. Three distinct artifacts, each confirmed by reading real stored
-- diffs rather than assumed:
--
--   1. EMPTY LEADING CELLS -- a rowspan continuation that used to render as a
--      bare "1750'" now correctly renders as " | 1750'". AIM 10-2-1:
--        removed: "0° to 179° | 750'\n1750'\n2750'"
--        added:   "0° to 179° | 750'\n | 1750'\n | 2750'"
--
--   2. PRIVATE-USE SENTINEL -- table blocks are now marked with U+E000, which
--      the client parser keys off. FAR 29.853:
--        removed: "Passenger capacity | Fire extinguishers\n7 through 30 | 1"
--        added:   "Passenger capacity | Fire extinguishers\n7 through 30 | 1"
--
--   3. HEADER MERGING -- mergeHeaderRows() propagates a spanned header across
--      each column it covers, so one merged cell became several repeated ones.
--        removed: "Minimum separation distances Centimeters"
--        added:   "Minimum separation distances" + "Centimeters"
--
-- PROOF THAT NONE OF THE 121 IS A REAL CHANGE, before deleting anything:
--   * Zero of the 121 have any remaining difference in NON-table prose. A real
--     FAA amendment essentially always touches prose.
--   * Comparing word MULTISETS (ignoring cell/line boundaries entirely), the
--     differences are words appearing only in the NEW text -- header words
--     duplicated across the columns they span. Nothing was lost.
--   * The one case with tokens only on the OLD side (AIM 5-3-1) has an
--     IDENTICAL token count old vs new (842 = 842), i.e. re-partitioned, not
--     dropped. Checked specifically because silent data loss would matter far
--     more than a noisy Changed tab.
--
-- All 121 rows were dumped to JSON before this ran, so the delete is reversible.
--
-- Root cause is fixed at the source in sync/revision_log.py, which now strips
-- private-use sentinels and empty table cells BEFORE comparing -- so the next
-- re-scrape cannot recreate this. That normalization is comparison-only; the
-- original text is still what gets stored and shown for a genuine change.

begin;

delete from public.content_revisions
where revised_at::date = '2026-08-31';

commit;

-- VERIFY: the Changed tab should now show only the 2026-08-03 FAR batch and the
-- 2026-08-17 AD batch -- 19 real entries, not 140.
