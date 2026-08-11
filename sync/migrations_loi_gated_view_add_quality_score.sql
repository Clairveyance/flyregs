-- legal_interpretations_gated was created before ocr_quality_score existed
-- on the base table (added in the same-day LOI-quality-scan work), so the
-- view never picked it up. Needed now to show an in-doc quality disclaimer
-- (RC: "for any doc that may have odd gaps or artifacts... we need a short
-- disclaimer inside each doc", matching the existing AC scanned-original
-- banner pattern). Not gated content -- it's a quality metric about the
-- text, not the text itself -- so it's visible at every tier, same as
-- summary/title/cfr_reference already are.
CREATE OR REPLACE VIEW public.legal_interpretations_gated AS
 SELECT id,
    slug,
    doc_unique_id,
    title,
    addressee,
    year,
    issued_date,
    source_url,
        CASE
            WHEN has_pro_access() THEN pdf_url_cached
            ELSE NULL::text
        END AS pdf_url_cached,
    cfr_part_reference,
    cfr_section_reference,
    summary,
        CASE
            WHEN has_pro_access() THEN body_text
            ELSE NULL::text
        END AS body_text,
    size_bytes,
    text_quality,
    superseded_by,
    created_at,
    updated_at,
    ocr_quality_score
   FROM legal_interpretations;
