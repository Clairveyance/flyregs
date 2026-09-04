-- content_revisions: accept doc_type='loi', and Pro-gate its diff text.
--
-- THE BUG
-- -------
-- loi_scraper.py has called log_revisions(doc_type="loi", ...) since
-- 2026-08-29 (line ~402). content_revisions' doc_type CHECK constraint has
-- never allowed 'loi':
--     CHECK (doc_type = ANY (ARRAY['ac','far','aim','pcg','ad','cfr49']))
-- so EVERY LOI revision insert has been rejected by the database. The call
-- site wraps it in `except Exception as e: log.warning("...non-fatal")`, so
-- the scraper logged a warning and exited 0 -- the run "succeeded" while the
-- What's Changed timeline silently lost every LOI revision ever produced.
--
-- This is the identical silent-loss shape that
-- sync/migrations_cfr49_content_revisions_doctype.sql was written to PREVENT
-- for cfr49 ("but every cfr49 revision would silently vanish"). cfr49 got the
-- constraint widened; loi was wired up the same week and never did. Same bug
-- class as the four prior scraper_runs silent-logging incidents.
--
-- THE GATING HALF -- must ship together, not after
-- ------------------------------------------------
-- content_revisions_gated NULLs added_text/removed_text for ac/ad/cfr49 when
-- NOT has_plus_access(), and returns them verbatim in its ELSE branch. 'loi'
-- would fall through that ELSE. But legal_interpretations_gated gates LOI
-- body_text behind has_pro_access() -- STRICTER than Plus -- and a revision's
-- added_text/removed_text IS that body text, diffed. Widening the constraint
-- alone would therefore turn on a brand-new path for a free account to read
-- Pro-only LOI prose. There is no live leak today only because the constraint
-- blocks every write; the moment it is widened there would be. So the view is
-- corrected in the same transaction.
--
-- far/aim/pcg stay ungated: those corpora are free-tier readable, and their
-- own _gated views apply no tier CASE to the underlying text.

BEGIN;

ALTER TABLE public.content_revisions DROP CONSTRAINT IF EXISTS content_revisions_doc_type_check;
ALTER TABLE public.content_revisions ADD CONSTRAINT content_revisions_doc_type_check
  CHECK (doc_type = ANY (ARRAY['ac'::text, 'far'::text, 'aim'::text, 'pcg'::text, 'ad'::text, 'cfr49'::text, 'loi'::text]));

CREATE OR REPLACE VIEW public.content_revisions_gated AS
 SELECT id, doc_type, doc_key, doc_id, title,
    CASE
      WHEN doc_type = 'loi'::text AND NOT has_pro_access() THEN NULL::text
      WHEN (doc_type = ANY (ARRAY['ac'::text, 'ad'::text, 'cfr49'::text])) AND NOT has_plus_access() THEN NULL::text
      ELSE added_text
    END AS added_text,
    CASE
      WHEN doc_type = 'loi'::text AND NOT has_pro_access() THEN NULL::text
      WHEN (doc_type = ANY (ARRAY['ac'::text, 'ad'::text, 'cfr49'::text])) AND NOT has_plus_access() THEN NULL::text
      ELSE removed_text
    END AS removed_text,
    revised_at, created_at
   FROM content_revisions;

COMMIT;
