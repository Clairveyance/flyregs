-- acs_total/acs_added/acs_updated/acs_errors/acs_cancelled/csv_reachable
-- are the only scraper_runs columns left with a hard DB default (0/0/0/0/
-- 0/true) -- a leftover from when this table was AC-only, before
-- migrations_scraper_runs_far_aim_pcg_columns.sql /
-- migrations_scraper_runs_ad_columns.sql /
-- migrations_scraper_runs_loi_cfr49_columns.sql added every other source's
-- own column set, all correctly left nullable with NO default. Found in
-- the 2026-08-29 corpus-freshness sweep as a real, currently-live bug: any
-- non-AC scraper's log_scraper_run() insert (which never specifies these
-- AC-only columns at all) silently gets acs_total=0/acs_added=0/etc.
-- instead of NULL, making a real FAR/AIM/P-CG/AD/LOI/CFR49 run row LOOK
-- like an AC run that processed 0 documents. Confirmed live: 8+ real rows
-- have acs_total=0 while a completely different source's own columns are
-- populated in the same row. This means "WHERE acs_total IS NOT NULL" --
-- the obvious query for "when did AC last run" -- silently returns
-- whichever source ran most recently, not AC; the audit that found this
-- bug had to hand-write a `far_sections_total IS NULL AND aim_... IS NULL
-- AND ...` filter to work around it, which nothing else in the repo does.
--
-- DROP DEFAULT only changes what a FUTURE insert that omits these columns
-- gets (NULL, matching every other source) -- it does not touch any
-- already-stored row's existing value, so this is non-destructive to
-- historical scraper_runs data. This table is purely an internal ops/
-- diagnostics log (scripts/audits only, never read by the shipped app),
-- so there's no client-build compatibility concern the way an app-facing
-- table would have.
alter table public.scraper_runs
  alter column acs_total drop default,
  alter column acs_added drop default,
  alter column acs_updated drop default,
  alter column acs_errors drop default,
  alter column acs_cancelled drop default,
  alter column csv_reachable drop default;
