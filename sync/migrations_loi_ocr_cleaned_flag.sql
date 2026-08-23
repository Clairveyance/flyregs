-- Real data-loss bug, caught and fixed same-day (2026-08-23): loi_scraper.py's
-- weekly re-sync unconditionally overwrites body_text from DRS's raw OCR
-- text layer on every run -- which is exactly right for picking up new/
-- changed source PDFs, but has no awareness that a LOCAL Vision/text-only
-- OCR cleanup pass might have already produced a BETTER version of that
-- same text than DRS's own raw layer (which never improves on its own --
-- DRS serves the same scan-quality text forever). A manually-dispatched
-- CI run of weekly-loi-sync.yml, run the same day as a real OCR cleanup
-- pass (severe + mild/moderate tiers, 226 documents, ~$8.54 real spend),
-- silently reverted 217 of those 226 back to their original garbled text
-- -- confirmed live via ocr_quality_score jumping back to its pre-cleanup
-- value for docs like kearns-1991 (3.58 -> 9.37, its exact original score).
--
-- Fix: a real flag the scraper checks before ever touching body_text again.
alter table public.legal_interpretations
  add column if not exists ocr_cleaned_at timestamptz;

comment on column public.legal_interpretations.ocr_cleaned_at is
  'Set by loi_vision_cleanup.py or loi_text_cleanup.py whenever either successfully rewrites body_text with a cleaned version. loi_scraper.py must never overwrite body_text for a row where this is set -- DRS''s own raw OCR text never improves on a re-scrape, so re-writing it here would only ever regress a real fix. Metadata/citations/dates still refresh normally regardless of this flag.';
