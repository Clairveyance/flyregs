-- Real, live-confirmed severe gap found during the B34 forensic gating
-- re-audit (2026-08-16): quizzable_advisory_circulars (and, on inspection,
-- all 4 of its siblings) grants SELECT to anon AND authenticated, despite
-- selecting straight off the raw underlying table with zero Plus/Pro
-- redaction. Live-confirmed exploitable with only the public anon key:
--
--   GET .../quizzable_advisory_circulars?select=document_number,pdf_text
--
-- returned the complete, un-redacted pdf_text of a real AC with no
-- authentication at all -- a full bypass of the Plus paywall on AC
-- content (advisory_circulars_gated is the correct, redacted, actually
-- paywalled view every client screen reads from instead).
-- quizzable_dictionary_terms has the same shape for its Pro-gated
-- mnemonic rows (smaller blast radius -- only the one-line definition via
-- quiz_prompt, not the full letter-by-letter breakdown).
--
-- Root cause: these 5 views exist purely as internal input to the
-- question-bank/fact authoring pipeline (scripts/author_question_bank.py,
-- author_dictionary_facts.py, build_mnemonic_letter_facts.py,
-- filter_matrix_test.py) -- confirmed via a full grep of src/ and
-- supabase/functions/ turning up ZERO client or Edge Function usage of
-- any quizzable_* view. Every one of those scripts already runs with the
-- service-role key, which bypasses grants entirely -- so anon/
-- authenticated access was never needed for these to work, and revoking
-- it changes nothing about how the authoring pipeline itself functions.
--
-- Fix: revoke SELECT (and the incidental TRIGGER/REFERENCES grants that
-- came along with it, equally unneeded) from anon and authenticated on
-- all 5 quizzable_* views. service_role and postgres are untouched.
revoke select, trigger, references on public.quizzable_advisory_circulars from anon, authenticated;
revoke select, trigger, references on public.quizzable_aim_paragraphs from anon, authenticated;
revoke select, trigger, references on public.quizzable_dictionary_terms from anon, authenticated;
revoke select, trigger, references on public.quizzable_far_sections from anon, authenticated;
revoke select, trigger, references on public.quizzable_pcg_terms from anon, authenticated;
