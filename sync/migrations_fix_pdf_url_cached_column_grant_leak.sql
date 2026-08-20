-- Found 2026-08-19/20, full-app tier-gating re-sweep (RC: "worth doing a
-- complete pass on the entire gating infrastructure").
--
-- advisory_circulars_gated / legal_interpretations_gated both correctly
-- redact pdf_url_cached via `CASE WHEN has_plus_access()/has_pro_access()
-- THEN pdf_url_cached ELSE NULL END` -- but the RAW base tables' own
-- column-level GRANTs (migrations_paid_content_column_privileges.sql,
-- 2026-08-05) never included pdf_url_cached in either table's `denied`
-- array, only pdf_blocks/pdf_text/body_text/search_vector. Same exact bug
-- shape gotcha_rls_does_not_gate_columns.md already documented and fixed
-- for the body-text columns -- a gated VIEW proves nothing about the RAW
-- table underneath it, and this one column was missed the first time.
--
-- advisory_circulars.changed_block_indices has the identical gap: its view
-- redaction was added later (migrations_fix_ac_changed_block_indices_leak.
-- sql, 2026-08-14) but that fix only touched the view, never re-ran the
-- column-privilege DO block to add the new column to the denied list.
-- Currently dormant (0 rows populated anywhere in the corpus as of this
-- writing -- no AC has been revised yet), but a real gap that would leak
-- the moment a real "What's Changed" revision lands.
--
-- Live-confirmed exploitable with nothing but the public anon key baked
-- into the app bundle, zero session, zero account:
--   GET .../advisory_circulars?select=document_number,pdf_url_cached
--     -> real Supabase-storage PDF URL for a Plus-gated AC
--   GET .../legal_interpretations?select=slug,pdf_url_cached
--     -> real Supabase-storage PDF URL for a Pro-gated LOI
-- This is a strictly worse exposure than gotcha_open_pdf_tier_gate_leak.md's
-- original finding: that fix closed the in-app "Open PDF" BUTTON (client-
-- side), but the underlying pdf_url_cached value was always fetchable
-- directly from the raw table via one REST call the whole time, for EVERY
-- document, not just ones a user had already opened before a downgrade.
--
-- IMPORTANT -- this migration closes the "trivial DB enumeration" vector
-- only, not the full leak. document_number/slug are (correctly) free
-- metadata, and the storage filename pattern is a deterministic function of
-- it (document_number with '/' -> '_', + '.pdf') -- confirmed live that a
-- filename GUESSED from a normal, ungated metadata query, with zero read of
-- pdf_url_cached at all, still 200s against the public storage bucket:
--   .../storage/v1/object/public/advisory-circulars/<guessed>.pdf
-- The `advisory-circulars`/`legal-interpretations` Storage buckets
-- themselves are still `public: true` (confirmed via storage.buckets).
-- This was already explicitly flagged and deliberately deferred in
-- gotcha_gating_sweep_2026_08_11.md ("AC/LOI/AD Storage buckets are still
-- fully public at the Storage level... full closure needs private buckets
-- + authenticated fetch... a genuinely separate, higher-risk client
-- architecture change") -- that assessment undersold the residual risk
-- (it assumed the app-level gate meant "only someone who already has a
-- URL" could reach it; this migration proves the URL is fully guessable
-- from public metadata alone, no prior URL needed) but the underlying
-- judgment call about NOT rushing a signed-URL rearchitecture stands.
-- Re-flagged to RC as the top open item from this sweep, not attempted
-- here -- see PROJECT_NOTES/flyregs_pending.md's 2026-08-19/20 entry.

DO $$
DECLARE
  t record;
  denied text[];
  cols text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'advisory_circulars',
      'legal_interpretations'
    ]) AS tbl
  LOOP
    denied := CASE t.tbl
      WHEN 'advisory_circulars'    THEN ARRAY['pdf_blocks', 'pdf_text', 'search_vector', 'pdf_url_cached', 'changed_block_indices']
      WHEN 'legal_interpretations' THEN ARRAY['body_text', 'pdf_url_cached']
    END;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = t.tbl
       AND NOT (column_name = ANY(denied));

    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', t.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', cols, t.tbl);

    RAISE NOTICE '% -> denied: %', t.tbl, denied;
  END LOOP;
END $$;
