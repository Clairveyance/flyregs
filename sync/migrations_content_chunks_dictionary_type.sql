-- Allow source_type='dictionary' in content_chunks (task #63, 2026-08-05).
--
-- Mnemonics (build_embeddings.py's new "mnemonic" doc_type) are stored
-- under source_type "dictionary" so Ask FlyRegs' existing RegType
-- routing/icon/label (ask-flyregs.tsx, citedItems.ts) just works, rather
-- than teaching those a brand-new "mnemonic" type. The CHECK constraint
-- below only allowed the original six content types and rejected every
-- write with a 400 until this ran.
ALTER TABLE public.content_chunks
  DROP CONSTRAINT content_chunks_source_type_check;

ALTER TABLE public.content_chunks
  ADD CONSTRAINT content_chunks_source_type_check
  CHECK (source_type = ANY (ARRAY['far'::text, 'aim'::text, 'pcg'::text, 'ac'::text, 'ad'::text, 'loi'::text, 'dictionary'::text]));
