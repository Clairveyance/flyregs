-- Night-rules content-freshness investigation, 2026-08-09 (follow-on to
-- migrations_scraper_runs_acs_cancelled.sql, same investigation).
--
-- After fixing the AC scraper's own missing acs_cancelled column, checked
-- whether far_scraper.py/aim_scraper.py/pcg_scraper.py's identical
-- log_scraper_run() (same bare try/POST/except:pass, copy-pasted into all
-- three, writing to this same shared table) had the same problem -- and
-- found something much bigger: NONE of their run_record field names had
-- EVER matched a real column on scraper_runs, which only ever had
-- faa_scraper.py's own AC-specific columns (acs_total/acs_added/etc).
--
-- far_scraper.py's run_record used: far_parts_total, far_sections_total,
--   far_sections_dated, far_errors
-- aim_scraper.py's run_record used: aim_paragraphs_total, aim_figures_total,
--   aim_citations_total, aim_errors, aim_upsert_failures
-- pcg_scraper.py's run_record used: pcg_total, pcg_upserted, pcg_errors
--
-- Every one of those inserts got rejected by PostgREST (unknown column) and
-- silently swallowed by the old `except: pass`. Confirmed the actual FAR/
-- AIM/PCG weekly syncs WERE running correctly the whole time (far_sections/
-- aim_paragraphs/pcg_terms all show real updated_at timestamps matching
-- their Monday cron schedules) -- only the monitoring-row write was
-- silently broken, this whole time, for all three sources.
--
-- Fixed at both layers: these columns, and log_scraper_run() in all three
-- scrapers no longer swallows a failed insert silently (see each file's own
-- updated comment) -- so any FUTURE schema drift shows up in the run's own
-- GitHub Actions log instead of vanishing the same way again.

alter table scraper_runs
  add column if not exists far_parts_total integer,
  add column if not exists far_sections_total integer,
  add column if not exists far_sections_dated integer,
  add column if not exists far_errors integer,
  add column if not exists aim_paragraphs_total integer,
  add column if not exists aim_figures_total integer,
  add column if not exists aim_citations_total integer,
  add column if not exists aim_errors integer,
  add column if not exists aim_upsert_failures integer,
  add column if not exists pcg_total integer,
  add column if not exists pcg_upserted integer,
  add column if not exists pcg_errors integer;
