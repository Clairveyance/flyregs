-- Night-rules follow-up to the 2026-08-09 scraper_runs silent-schema-drift
-- fix (see migrations_scraper_runs_far_aim_pcg_columns.sql and
-- gotcha_scraper_runs_silent_schema_drift.md). ad_scraper.py had NO
-- scraper_runs logging at all -- a flagged-but-not-fixed gap from that same
-- investigation. Closing it now with the same non-silent log_scraper_run()
-- pattern used by the other four scrapers.

alter table scraper_runs
  add column if not exists ad_total integer,
  add column if not exists ad_added integer,
  add column if not exists ad_errors integer;
