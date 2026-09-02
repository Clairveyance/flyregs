-- Remove pointless SELECT grants that sit one policy away from a leak (2026-09-03)
--
-- content_chunks holds 49,872 rows of CHUNKED FULL TEXT for AC, AD, LOI and
-- 49 CFR -- exactly the bodies every *_gated view redacts. It has column-level
-- SELECT granted to anon AND authenticated, including `chunk_text` and
-- `embedding`, and the only thing preventing a leak today is that RLS is
-- enabled with ZERO policies (deny-all). Confirmed live: anon and free both get
-- 0 rows.
--
-- That is one well-meaning `USING (true)` away from publishing the entire paid
-- corpus in a single statement -- which is precisely how the
-- synced_bookmarks_gated incident happened (2026-08-30: a view with no row
-- filter plus an anon SELECT grant, proven exploitable with a bare curl).
--
-- The grants serve no purpose. Verified before revoking, and NOT simply assumed
-- (the audit report claimed "every reader is a definer function", which is not
-- quite true):
--   * hybrid_search and semantic_search ARE invoker-rights over content_chunks
--     -- but EXECUTE is already revoked from anon and authenticated on both
--     (has_function_privilege = false), so neither is reachable.
--   * related_by_topic is SECURITY DEFINER, so it bypasses grants entirely. It
--     is the only one of the three with a client caller (relatedContent.ts).
--   * No client code reads either table directly (grepped src/).
--
-- Same reasoning for challenge_questions: its question/choices/correct_answer
-- columns are granted to anon while table-level SELECT was already revoked, and
-- all ten of its readers are SECURITY DEFINER.

-- NOTE: the table-level REVOKE below is what actually does the work here.
-- A per-COLUMN revoke was attempted first and reported "0 needed", because
-- these were table-level SELECT grants surfacing per-column in
-- information_schema.column_privileges -- not column-level grants. What remains
-- afterwards is 9 REFERENCES entries per role per table, which only permit
-- creating a foreign key and grant no read access. Verified after applying:
-- has_table_privilege(anon|authenticated, 'SELECT') = false on both.

begin;

revoke select on public.content_chunks from anon, authenticated;
revoke select on public.challenge_questions from anon, authenticated;

commit;

-- VERIFY: related_by_topic must still return rows (it is definer), and the
-- Duels flow must still work end to end.
