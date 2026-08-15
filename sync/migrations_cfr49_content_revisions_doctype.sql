-- Extends content_revisions' doc_type CHECK to accept 'cfr49' alongside the
-- existing ac/far/aim/pcg/ad. cfr49_scraper.py calls the shared
-- log_revisions() helper (sync/revision_log.py) exactly like far_scraper.py
-- does, so without this the very first scraper run's revision-log insert
-- would fail the CHECK constraint on every row (caught + logged by
-- log_revisions' own per-row try/except, so it wouldn't crash the scrape,
-- but every cfr49 revision would silently vanish -- same silent-loss shape
-- already documented for scraper_runs, worth avoiding rather than
-- discovering later).
--
-- content_revisions_gated only redacts doc_type IN ('ac','ad') for non-Plus
-- (confirmed via pg_get_viewdef) -- 'cfr49' falls through its ELSE branch
-- automatically, same free-tier treatment as far/aim/pcg already get. No
-- view change needed, only this constraint.
ALTER TABLE public.content_revisions DROP CONSTRAINT content_revisions_doc_type_check;
ALTER TABLE public.content_revisions ADD CONSTRAINT content_revisions_doc_type_check
  CHECK (doc_type = ANY (ARRAY['ac'::text, 'far'::text, 'aim'::text, 'pcg'::text, 'ad'::text, 'cfr49'::text]));
