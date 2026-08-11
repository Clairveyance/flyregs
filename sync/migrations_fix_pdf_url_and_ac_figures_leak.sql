-- Found 2026-08-11, app-wide gating sweep. Two related leaks around the
-- same root cause: gated content whose ACTUAL BYTES live in a public
-- Supabase Storage bucket, reachable directly once you have the URL,
-- regardless of any RLS/column-privilege work on the DB row itself.
--
-- 1. pdf_url_cached was passed through *_gated views unconditionally --
--    same "metadata, not content" treatment as document_number/title,
--    but it's a direct pointer to the full protected PDF, not metadata.
--    Live-confirmed: a fully anonymous account could read this column via
--    advisory_circulars_gated/legal_interpretations_gated (already the
--    RIGHT view -- this wasn't the raw-table bypass migrations_paid_content_
--    column_privileges.sql already closed) and fetch the complete PDF
--    directly from the public bucket. Nulling it here removes the one path
--    the app itself hands a free user to the file; the client already only
--    renders the "Open PDF" action when this column is present (ac/[id].tsx,
--    loi/[slug].tsx), so this also correctly hides that action for free
--    users rather than leaving it to fail confusingly.
--
--    NOT closed by this migration: the buckets (advisory-circulars,
--    legal-interpretations, ac-figures, ac-formula-refs) are still public
--    at the Storage level, so a URL obtained any OTHER way (a previously
--    saved link, guessing the filename pattern from a known document
--    number) still resolves. Closing that fully needs private buckets +
--    an authenticated fetch path (signed URLs or an auth-header-aware
--    viewer) -- a separate, more invasive change to how the PDF viewer and
--    every image component fetch these assets, flagged as follow-up work
--    rather than rushed here given the blast radius of getting client-side
--    authenticated fetching wrong (breaking PDF/figure viewing app-wide).
--
-- 2. ac_figures/ac_formula_refs had zero gating anywhere -- USING (true)
--    RLS, no _gated view, despite ac/[id].tsx's own comment declaring them
--    Plus-tier content identical to the AC body text ("AC/LOI full text,
--    figures, highlights... are all Plus-tier now"). Only the client
--    RENDER was gated (`hasPlusAccess ? figures : undefined`); the fetch
--    itself, and any direct REST read, was not. Unlike pdf_blocks/pdf_text
--    there's no "free preview" of figures in the existing UX (all-or-
--    nothing, matching the render gate above) -- so a row-level RLS check
--    is the correct shape here, not a column-level split, and needs no
--    client change since the client already reads these tables by name
--    expecting either the real rows or nothing.

CREATE OR REPLACE VIEW public.advisory_circulars_gated AS
 SELECT id, document_number, title, date_issued, office, change_number,
        status, subject_series, description, document_id, cancels,
        pdf_url_faa,
        CASE WHEN has_plus_access() THEN pdf_url_cached ELSE NULL END AS pdf_url_cached,
        pdf_size_bytes,
        CASE
            WHEN has_plus_access() THEN pdf_text
            ELSE left(pdf_text, 2000)
        END AS pdf_text,
        last_scraped_at, created_at, updated_at,
        CASE
            WHEN has_plus_access() THEN pdf_blocks
            ELSE jsonb_path_query_array(pdf_blocks, '$[0 to 1]'::jsonpath)
        END AS pdf_blocks,
        pdf_blocks_version,
        changed_block_indices,
        COALESCE(jsonb_array_length(pdf_blocks), 0) AS pdf_blocks_total_count
   FROM advisory_circulars;

CREATE OR REPLACE VIEW public.legal_interpretations_gated AS
 SELECT id, slug, doc_unique_id, title, addressee, year, issued_date,
        source_url,
        CASE WHEN has_pro_access() THEN pdf_url_cached ELSE NULL END AS pdf_url_cached,
        cfr_part_reference, cfr_section_reference, summary,
        CASE
            WHEN has_pro_access() THEN body_text
            ELSE NULL::text
        END AS body_text,
        size_bytes, text_quality, superseded_by, created_at, updated_at
   FROM legal_interpretations;

DROP POLICY IF EXISTS public_read_ac_figures_rows ON public.ac_figures;
CREATE POLICY public_read_ac_figures_rows ON public.ac_figures
  FOR SELECT USING (has_plus_access());

DROP POLICY IF EXISTS public_read_ac_formula_refs ON public.ac_formula_refs;
CREATE POLICY public_read_ac_formula_refs ON public.ac_formula_refs
  FOR SELECT USING (has_plus_access());
