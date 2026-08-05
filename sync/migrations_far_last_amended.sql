-- Real per-section amendment dates for the FARs (2026-08-05).
--
-- Background: `far_sections.updated_at` is a SYNC STAMP, not a change date.
-- far_scraper.py unconditionally writes now() on every row on every run, by
-- original documented design ("eCFR always serves the current version, no
-- separate 'what changed' tracking needed"). Confirmed live: 4,290 of 4,292
-- rows share one date, and the handful of "distinct" values are just per-row
-- write times inside a single 5-minute sync run. That made Home's Date Range
-- filter an all-or-nothing toggle for FAR (0 results or all 4,292), which is
-- why it's currently hidden for FAR/AIM/P-CG-only selections.
--
-- The original assumption was wrong: eCFR DOES publish real change history,
-- at GET /api/versioner/v1/versions/title-14.json. Every section carries an
-- `amendment_date`, one row per amendment, back to when eCFR began tracking.
-- Measured 2026-08-05: 15,319 version rows -> 6,349 live sections, and
-- 4,290 of our 4,292 rows match one (99.95%). The two misses (93.101,
-- 93.103) are genuinely absent from eCFR's version index.
--
-- Two things this column deliberately does NOT claim:
--
--   1. It is the LATEST amendment, not a full history. One date per section
--      is what a Date Range filter needs; the full per-amendment series
--      stays in eCFR if it's ever wanted.
--   2. ~74% of sections sit at eCFR's tracking-start floor (2016-08-01,
--      2016-12-05, 2016-12-30, 2017-01-01). For those, the true meaning is
--      "not amended since at least this date" -- eCFR simply has no record
--      further back. That is still correct for range filtering ("changed in
--      the last 90 days / year / 5 years" answers truthfully), but it must
--      NOT be rendered as "last amended <date>" in the UI, because for an
--      old section the real answer could be 1963. Any display use has to
--      respect last_amended_is_floor.

ALTER TABLE public.far_sections
  ADD COLUMN IF NOT EXISTS last_amended date,
  -- True when the date is eCFR's tracking-start floor rather than an
  -- observed amendment -- i.e. "no later than", not "on".
  ADD COLUMN IF NOT EXISTS last_amended_is_floor boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.far_sections.last_amended IS
  'Latest eCFR amendment_date for this section. Real change history, unlike updated_at (a sync stamp). See last_amended_is_floor before displaying it as an exact date.';

COMMENT ON COLUMN public.far_sections.last_amended_is_floor IS
  'True when last_amended is eCFR''s tracking-start floor (2016-08-01 / 2016-12-05 / 2016-12-30 / 2017-01-01), meaning "not amended since at least this date" rather than "amended on this date". Safe for range filtering; not safe to display as an exact amendment date.';

CREATE INDEX IF NOT EXISTS far_sections_last_amended_idx
  ON public.far_sections (last_amended DESC NULLS LAST);
