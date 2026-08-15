-- Real, significant, pre-existing MagicLink bug found 2026-08-13 while
-- verifying the new related_by_topic() semantic layer against RC's own RNP
-- example. Confirmed live via a raw anon-key REST call:
--
--   document_citations_gated?citing_type=eq.aim&citing_id=eq.4-7-3  ->  []
--
-- even though 3 real rows exist (confirmed as postgres). Root cause: the
-- view masks citing_id/cited_id themselves to NULL for non-Pro callers --
--   CASE WHEN has_pro_access() THEN cited_id ELSE NULL END AS cited_id
-- -- but EVERY screen's citation fetch (far/aim/ac/ad/loi/pcg detail
-- pages) filters ON those same columns (`.eq('cited_id', id)` / an
-- `.or(...)` across citing_id/cited_id). PostgREST's WHERE filter is
-- applied to the view's OUTPUT, after the CASE already ran -- so for any
-- caller where has_pro_access() is false, cited_id is NULL on every row
-- before the filter even looks at it, and `WHERE NULL = '4-7-3'` can never
-- be true. The query doesn't error, doesn't 403 -- it silently returns
-- zero rows, every time, for every Free/Plus/anonymous caller, regardless
-- of how many real citations actually exist.
--
-- This directly contradicts MagicLinkPod.tsx's own documented design
-- intent ("Counts always show for every user... the expand-and-navigate
-- action is Pro-gated... the cross-reference convenience is the paywalled
-- thing, not the fact that connections exist") -- in practice the COUNT
-- itself has been showing ~0 for every non-Pro user this whole time, not
-- just the detail list.
--
-- Fix: citing_id/cited_id/citing_type/cited_type are structural identifiers
-- needed to even ASK "what cites this document", not "content" -- keeping
-- them masked serves no real paywall purpose (a Free-tier user can already
-- see "AC 90-105" exists and is freely browsable; FAR/AIM/AC/AD/LOI numbers
-- aren't sensitive on their own) and actively breaks the feature. `label`
-- stays masked -- it's the one genuinely descriptive/enriched field, and
-- the client already blocks the real value (tap-to-expand, tap-to-navigate,
-- MagicLinkPod's handlePressBar) behind hasProAccess regardless of what
-- this view returns. No client change needed -- every screen already
-- filters on cited_id/citing_id expecting them to be real values; this
-- just makes that assumption true for every tier again.
create or replace view public.document_citations_gated as
select
  id,
  citing_type,
  citing_id,
  cited_type,
  cited_id,
  case when has_pro_access() then label else null::text end as label
from public.document_citations;
