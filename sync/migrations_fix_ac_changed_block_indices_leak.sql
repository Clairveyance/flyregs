-- Found 2026-08-14, comprehensive gating/paywall re-audit (RC: "we don't
-- want lower tier users being able to access upper tier content").
--
-- advisory_circulars_gated already redacts pdf_text/pdf_blocks down to a
-- 2-block preview for non-Plus tiers (migrations_fix_pdf_url_and_ac_figures_
-- leak.sql), but changed_block_indices was passed through completely
-- unredacted regardless of tier. ac/[id].tsx reads it unconditionally --
-- no hasPlusAccess check wraps the "Updated-content banner" -- to render
-- "This AC was updated -- N sections changed (§ labels...)" with working
-- prev/next jump navigation, and passes the same array straight into
-- ACBody as `changedIndices`, which draws a blue left-border + "UPDATED"
-- tag on any block whose index is in the set. Confirmed live: for any free
-- user, this leaks (a) the exact count of sections changed in the FULL
-- document regardless of tier, and (b) for any changed index that happens
-- to fall inside the free 2-block preview window (blocks 0-1), the actual
-- visual "this exact block changed" marker on real body content they
-- haven't paid for -- exactly the "What's Changed" feature paywall.tsx
-- documents as PLUS_FEATURES ("What's Changed -- see exactly what the FAA
-- revised"), for free, on the one content type (AC) where it should matter
-- most since AC body text is itself Plus-gated.
--
-- Fixed the same way pdf_text/pdf_blocks already are -- redact at the view,
-- not just the client -- so ac/[id].tsx's existing `changedList.length > 0`
-- guard (already used to hide the whole banner) does the rest for free with
-- no client code change needed: a free user's changed_block_indices is now
-- NULL, changedList becomes [], and the banner + ACBody's per-block
-- "UPDATED" tag both naturally stop rendering. No change to the Plus+ path
-- (still gets the full array, same as before).

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
        CASE
            WHEN has_plus_access() THEN changed_block_indices
            ELSE NULL::integer[]
        END AS changed_block_indices,
        COALESCE(jsonb_array_length(pdf_blocks), 0) AS pdf_blocks_total_count
   FROM advisory_circulars;
