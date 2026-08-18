-- Fixes a raw numeric HTML entity ("&#160;", non-breaking space) surviving
-- into 15 recent ADs' body_text (2026-15-11 through 2026-16-13, effective
-- Aug 28-Sep 18 2026). Found while auditing the corpus for grammar/OCR
-- quality issues (RC: "be more diligent and scrutinous with checking them
-- all for errors and inconsistencies").
--
-- Every instance is the exact same source pattern: a Cloudflare-obfuscated
-- compliance-contact email renders in the Federal Register's own published
-- full text as the literal fallback placeholder "[email protected]" (this
-- is FR's own record, not something our scraper garbled), and in these 15
-- documents the space inside that placeholder survived as a raw numeric
-- entity instead of a real space character -- "[email&#160;protected]".
-- The actual underlying email address isn't recoverable from this source
-- at all (FR's published text never contained it), so this migration ONLY
-- fixes the space character -- it never invents contact info.
--
-- sync/ad_scraper.py's decode_sgml_entities() has been extended
-- (NUMERIC_ENTITY_RE) to decode this class going forward so a future
-- re-scrape of these same ADs (or any new AD with the same artifact)
-- doesn't reintroduce it. This migration is the one-time backfill for the
-- 15 rows already stored before that fix landed -- confirmed via direct
-- corpus-wide query that body_text is the ONLY affected field (summary/
-- applicability/unsafe_condition all clean) and "&#160;" is the ONLY
-- numeric entity present anywhere in the AD corpus.
update airworthiness_directives
set body_text = replace(body_text, '&#160;', ' ')
where body_text like '%&#160;%';
