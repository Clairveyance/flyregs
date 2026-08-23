-- Found 2026-08-23, careful pre-B35 QA sweep: paywall.tsx sells "Full text
-- of 49 CFR (NTSB, TSA, hazmat)" as a Plus perk, and cfr49/[id].tsx gates
-- every secondary action (copy/highlight/bookmark/print/folder-add) on
-- hasPlusAccess -- but the actual body_text read went straight to the raw
-- cfr49_sections table, which carries no gating at all. Confirmed live: a
-- fully unauthenticated anon request returns the complete, untruncated
-- body_text (verified against a real TSA security-program section, 4233
-- chars, zero restriction) -- unlike AC/AD/LOI, which all correctly read
-- through their own _gated view. Same bug class as this codebase's own
-- documented gotcha_open_pdf_tier_gate_leak.md / gotcha_tier_gate_client_
-- side_only.md: a client-side-only check can never actually withhold data
-- that already shipped to the device in the API response.
--
-- Fix: a new cfr49_sections_gated view, same shape/pattern as
-- airworthiness_directives_gated (full body_text redaction to NULL for a
-- non-Plus caller -- no partial preview, matching how AD's own comment
-- describes 49 CFR being sold: full compliance/regulatory text, not a
-- teaser). Every other column is metadata already shown to Free users
-- elsewhere (part/subpart navigation, search, etc.) and is left untouched.

CREATE OR REPLACE VIEW public.cfr49_sections_gated AS
SELECT
  id,
  section_number,
  part,
  subpart_letter,
  subpart_title,
  title,
  CASE WHEN has_plus_access() THEN body_text ELSE NULL::text END AS body_text,
  updated_at,
  last_amended,
  last_amended_is_floor,
  citation_count,
  search_popularity
FROM public.cfr49_sections;

GRANT SELECT ON public.cfr49_sections_gated TO anon, authenticated;
