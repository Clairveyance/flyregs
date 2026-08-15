-- Closes the two temporary B31-compatibility stopgaps
-- (migrations_restore_document_citations_authenticated_read.sql,
-- migrations_restore_content_revisions_authenticated_read.sql) for good.
-- RC, 2026-08-14: "we can fix anything from B31, don't have to protect
-- B31, as we'll be pushing B32 soon." Confirmed via a dedicated gating
-- audit agent that build 31 was still the latest/only shipped build and
-- this stopgap was consequently still fully open for every current real
-- user -- document_citations was actively leaking Pro-gated citation
-- labels to any signed-in account via the raw table; content_revisions
-- was dormant (zero ac/ad rows exist yet) but would leak real regulatory
-- diff text the instant that pipeline produces rows.
--
-- Returns both tables to the ORIGINAL intended final state from their own
-- source migrations (migrations_fix_document_citations_tap_through_leak.sql,
-- migrations_fix_content_revisions_ungated_leak.sql) -- narrow safe-column
-- grants only, full access via the _gated views only. The current
-- codebase already queries only the _gated views everywhere (confirmed by
-- grep at the time the stopgaps were written); B32 will ship built from
-- this same codebase, so there is nothing left that depends on the wider
-- grant once B31 usage no longer needs protecting.
REVOKE SELECT ON public.document_citations FROM authenticated;
GRANT SELECT (id, citing_type, cited_type) ON public.document_citations TO authenticated;

REVOKE SELECT ON public.content_revisions FROM authenticated;
GRANT SELECT (id, doc_type, doc_key, doc_id, title, revised_at, created_at) ON public.content_revisions TO authenticated;
