-- CRITICAL, found 2026-08-11 during the app-wide gating sweep. content_revisions
-- (backs the "What's Changed" feature) had RLS `USING (true)` and full column
-- grants to anon AND authenticated on added_text/removed_text -- no gate at
-- all, missed by the 2026-08-05 remediation that gated advisory_circulars/
-- airworthiness_directives/legal_interpretations/dictionary_terms (see
-- migrations_paid_content_column_privileges.sql, same pattern applied here).
--
-- Live-confirmed exploitable with ZERO account, zero payment, a single
-- anonymous curl call: GET content_revisions?doc_type=eq.ad&select=added_text
-- returned the complete real regulatory text of a live AD. 72 real AD
-- revision rows were equally exposed. far/aim/pcg revisions stay ungated on
-- purpose -- those content types are Free-tier per the matrix; only ac/ad
-- (Plus) are redacted here, matching the same tier split the base content
-- tables already use. No ac rows exist yet, but AC revision-logging is
-- wired (backfill-blocks.mjs) and would hit the same leak the moment it's
-- live, so this closes both now rather than only the one with data today.

CREATE OR REPLACE VIEW public.content_revisions_gated AS
 SELECT id, doc_type, doc_key, doc_id, title,
        CASE
          WHEN doc_type IN ('ac', 'ad') AND NOT has_plus_access() THEN NULL
          ELSE added_text
        END AS added_text,
        CASE
          WHEN doc_type IN ('ac', 'ad') AND NOT has_plus_access() THEN NULL
          ELSE removed_text
        END AS removed_text,
        revised_at, created_at
   FROM content_revisions;

REVOKE SELECT ON public.content_revisions FROM anon, authenticated;
GRANT SELECT (id, doc_type, doc_key, doc_id, title, revised_at, created_at) ON public.content_revisions TO anon, authenticated;
GRANT SELECT ON public.content_revisions_gated TO anon, authenticated;
