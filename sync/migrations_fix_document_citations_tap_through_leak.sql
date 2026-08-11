-- MagicLink tap-through (Pro) -- found 2026-08-11 during the app-wide
-- gating sweep. document_citations had RLS `USING (true)` and full grants,
-- no gate at all -- a fully anonymous caller could read the complete
-- citation graph (citing_type, citing_id, cited_type, cited_id, label) for
-- any document via direct REST, identical to what MagicLinkPod's own
-- Pro-gated expand view shows. Reachable independently of MagicLinkPod's
-- client-side gate, which was already correct (only the tap/expand
-- interaction was gated, never the underlying fetch).
--
-- Counts must stay free ("MagicLink -- reference counts: unlock at Free,
-- counts always visible, tier-wide") -- so this can't be a blanket
-- has_pro_access() row-level block, that would break the free count
-- display too. cited_type/citing_type stay visible (needed for per-type
-- counting/grouping); cited_id/citing_id/label -- the specific identity a
-- caller could navigate to or reconstruct a route from -- are redacted for
-- non-Pro.
--
-- A plain view can't cleanly redact only "the OTHER document" in a
-- bidirectional citation row (a row about the CURRENT document, which
-- isn't secret, vs. the cited target, which is) -- that split depends on
-- which document the CALLER is asking about, and a view has no parameter
-- to know that. The 6 detail screens' own client-side normalization
-- (far/[id].tsx etc., matching citing_id/cited_id against the current doc
-- id to figure out "the other side") will slightly miscount a genuine
-- self-citing row for non-Pro callers once both ids are null -- accepted
-- tradeoff: self-citations are rare-to-nonexistent in this corpus, and the
-- count is a soft display number, not a security boundary. The real
-- boundary (can a non-Pro caller extract a specific document identity to
-- navigate to) is fully closed either way.
CREATE OR REPLACE VIEW public.document_citations_gated AS
 SELECT id, citing_type,
        CASE WHEN has_pro_access() THEN citing_id ELSE NULL END AS citing_id,
        cited_type,
        CASE WHEN has_pro_access() THEN cited_id ELSE NULL END AS cited_id,
        CASE WHEN has_pro_access() THEN label ELSE NULL END AS label
   FROM document_citations;

REVOKE SELECT ON public.document_citations FROM anon, authenticated;
GRANT SELECT (id, citing_type, cited_type) ON public.document_citations TO anon, authenticated;
GRANT SELECT ON public.document_citations_gated TO anon, authenticated;
