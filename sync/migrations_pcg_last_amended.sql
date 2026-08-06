-- P/CG real change-detected dates (2026-08-05, task #300).
--
-- P/CG has no FAA-published version history at all -- no eCFR-equivalent
-- (FAR), no Explanation of Changes page (AIM). The only signal available
-- is comparing each sync's freshly-scraped text against what's already in
-- the DB. revision_log.py's log_revisions() already does exactly this
-- comparison (paragraph-level diff, whitespace/label-noise filtered) to
-- populate the What's Changed timeline -- this reuses that same diff
-- instead of a separate hash mechanism, so a table/figure renumber (a
-- known false-positive already fixed there, see revision_log.py's own
-- comment) doesn't also falsely bump last_amended.
--
-- Coverage starts from whenever this ships forward -- there is no way to
-- retroactively know when a P/CG term last changed before this existed.
-- NULL means "no change observed since we started tracking," not "never
-- changed" -- same honesty rule as FAR's last_amended_is_floor.
ALTER TABLE public.pcg_terms
  ADD COLUMN IF NOT EXISTS last_amended date;

COMMENT ON COLUMN public.pcg_terms.last_amended IS
  'Date a real content change was detected at sync time (paragraph-level '
  'diff against the prior scrape), sourced going forward only -- P/CG has '
  'no FAA version-history feed to backfill from. NULL means no change has '
  'been observed since tracking started, not "never changed."';
