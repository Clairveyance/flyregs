-- RC, 2026-08-11: "I'm not sure if we're gonna need a secondary vision
-- pass to clean up all of the messy text and artifacts." Investigated
-- first rather than assuming -- confirmed real and widespread (see
-- scripts/loi_quality_scan.py and PROJECT_NOTES/flyregs_pending.md's
-- entry that day): ~40% of the 1055-doc LOI corpus shows significant OCR
-- garbling, worst cases nearly unreadable. The existing text_quality
-- column turned out to be a dead end for triage -- it's "ocr" on literally
-- every single row (confirmed live), a constant set once at ingest
-- ("every sample checked so far is a scanned letter" per loi_scraper.py's
-- own comment), never actually varying by document.
--
-- This is a real per-document score instead: a heuristic OCR-garbling
-- badness measure (dictionary-miss ratio + spurious mid-word-space
-- splitting + junk symbol runs), computed and backfilled for the full
-- existing corpus by scripts/loi_quality_scan.py --backfill. Purely
-- internal/additive -- not read by the app anywhere, no user-facing
-- change, zero cost (no external API calls, pure local text analysis).
-- Exists so a future decision about which documents actually need a paid
-- Vision re-extraction pass (never run without asking first, see
-- memory/feedback_ask_before_vision.md) can be made from real data
-- instead of guessing or re-running the scan from scratch.
ALTER TABLE legal_interpretations ADD COLUMN IF NOT EXISTS ocr_quality_score numeric;

COMMENT ON COLUMN legal_interpretations.ocr_quality_score IS
  'Heuristic OCR-garbling badness score (higher = worse), computed 2026-08-11 by scripts/loi_quality_scan.py from a dictionary-miss + spurious-mid-word-space heuristic against body_text. Not currently read by the app; for internal triage of which LOIs most need a Vision re-extraction pass. NULL means not yet scored.';
