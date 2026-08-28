-- Allow cfr49 in acs_task_citations.cited_type -- CFI RefPack audit, 2026-08-27
--
-- Found while checking why the CFI Ref Packet (FAA-S-ACS-25) never
-- surfaced 49 CFR 830 (accident/incident reporting) even though its own
-- references_text genuinely cites "49 CFR part 830" and a real CFI-oral
-- checklist RC provided lists it as expected material. Root cause:
-- sync/acs_reference_extract.py's own regex only ever matched "14 CFR
-- part..." -- confirmed at scale, 15 real tasks corpus-wide cite 49 CFR
-- and none of them ever made it into this table. Fixed the extractor to
-- also catch "49 CFR part N" (see that file's own updated header comment),
-- tagged 'cfr49' to match document_citations' existing convention for the
-- same content type -- but this table's own CHECK constraint predates
-- cfr49 being a real corpus content type here and only allowed
-- far/ac/aim, so the fixed extractor's first real run 400'd on every
-- insert. This migration is the other half of that fix.

ALTER TABLE public.acs_task_citations DROP CONSTRAINT acs_task_citations_cited_type_check;
ALTER TABLE public.acs_task_citations ADD CONSTRAINT acs_task_citations_cited_type_check
  CHECK (cited_type = ANY (ARRAY['far'::text, 'ac'::text, 'aim'::text, 'cfr49'::text]));
