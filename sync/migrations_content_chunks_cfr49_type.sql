-- Allow source_type='cfr49' in content_chunks.
--
-- Found 2026-08-22/23 night-rules QA pass while verifying the just-completed
-- embeddings catch-up run: build_embeddings.py's SOURCES dict (line ~97)
-- added a "cfr49" doc_type today ("cfr49_sections was never added here --
-- confirmed live 2026-08-23: 49 CFR has had zero rows in content_chunks
-- since its sync went live"), which writes straight through as
-- source_type="cfr49" (SOURCE_TYPE_OVERRIDE only remaps "mnemonic" ->
-- "dictionary"; every other doc_type is written as-is). But this table's
-- CHECK constraint was never widened to match -- it still only allowed the
-- original six types plus "dictionary" (added 2026-08-05 for mnemonics, see
-- migrations_content_chunks_dictionary_type.sql, the exact same fix shape
-- applied here).
--
-- Live-confirmed: `select source_type, count(*) from content_chunks group by
-- source_type` shows 0 cfr49 rows even after today's catch-up run (far/aim/
-- pcg/ac/ad/loi/dictionary all show real, freshly-updated counts). Every
-- cfr49 chunk that run attempted would have embedded successfully via
-- OpenAI (real spend already incurred) and then 400'd on the content_chunks
-- upsert with a 23514 CHECK-violation -- build_embeddings.py's own
-- upsert_chunks() catches that per-row and logs+skips it rather than
-- crashing, so this failed quietly rather than visibly. Net effect: Ask
-- FlyRegs (semantic-search) still cannot surface any 49 CFR content, exactly
-- as before this whole catch-up run -- the embedding-freshness gap and the
-- "49 CFR was never in the pipeline" gap are two separate bugs, and this
-- migration only fixes the second one.
--
-- This migration does NOT re-run the embeddings backfill -- per the night-
-- rules scope for this pass, sync/build_embeddings.py itself is owned by a
-- separate in-flight process and was not touched. RC needs to re-run it for
-- cfr49 specifically (e.g. `python3 sync/build_embeddings.py --type cfr49`
-- or whatever its real CLI flag is) once this constraint is live -- content_
-- chunks will keep showing 0 cfr49 rows, and Ask FlyRegs will keep being
-- unable to answer any 49 CFR question, until that run happens.
ALTER TABLE public.content_chunks
  DROP CONSTRAINT content_chunks_source_type_check;

ALTER TABLE public.content_chunks
  ADD CONSTRAINT content_chunks_source_type_check
  CHECK (source_type = ANY (ARRAY['far'::text, 'aim'::text, 'pcg'::text, 'ac'::text, 'ad'::text, 'loi'::text, 'dictionary'::text, 'cfr49'::text]));
