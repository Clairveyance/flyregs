-- LOI and 49 CFR both landed real weekly sync workflows 2026-08-18 but
-- neither scraper can actually log a run to scraper_runs -- loi_scraper.py
-- never called log_scraper_run() at all (no columns ever existed for it,
-- so it was never wired in from the start), and cfr49_scraper.py works
-- around the same gap by piggybacking its counts onto the unrelated
-- far_parts_total/far_sections_total/far_errors columns, making a real
-- CFR49 run indistinguishable from a real FAR run by column alone (you'd
-- have to cross-reference started_at against which cron fired). Found in
-- the 2026-08-23 scraper-automation audit RC asked for ("make sure...
-- kept up to date automatically").
--
-- Same naming convention as every existing content type's own column set
-- (far_*, aim_*, pcg_*, ad_*, acs_* for AC).
alter table public.scraper_runs
  add column if not exists loi_total integer,
  add column if not exists loi_added integer,
  add column if not exists loi_errors integer,
  add column if not exists cfr49_total integer,
  add column if not exists cfr49_added integer,
  add column if not exists cfr49_errors integer;
