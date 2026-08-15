-- RC, 2026-08-14: "let's bring in and build the most relevant additions to
-- the CFRs for our core audience. Then we can work on adding more parts
-- after release as updates" -- approving the build after confirming the
-- gap (see memory/flyregs_49cfr_content_gap_pending.md) and clarifying the
-- UI shape: "maybe we just add them inside the FARs (since they're closely
-- tied) and create top chips to see/sort each. FAR, HMR, NTSB, etc."
--
-- First pass, most-relevant-to-core-audience only (small + universally or
-- broadly needed): NTSB 830 (accident/incident reporting -- every pilot),
-- TSA 1552 (flight training security -- flight schools/CFIs), TSA 1544
-- (aircraft operator security), HMR 175 (carriage of hazmat by aircraft).
-- Deliberately deferred: HMR 172 (the Hazardous Materials Table itself,
-- likely 3000+ structured entries -- a fundamentally different, much
-- larger build, not a straightforward add to this schema), HMR 171/173
-- (172's own supporting definitions), TSA 1550, 49 CFR 40 -- all flagged
-- in the same memory file as real candidates for a later pass.
--
-- Mirrors far_sections/far_parts' exact shape (same column set, same
-- generated tsvector weighting, same open RLS) rather than inventing a new
-- shape -- these are structurally identical documents (eCFR's own
-- DIV6=SUBPART/DIV8=SECTION XML, confirmed live against Title 49's real
-- feed, byte-identical tag shape to Title 14's), just from a different CFR
-- Title. Kept as SIBLING tables to far_sections/far_parts, not merged into
-- them -- far_sections has no title/agency column anywhere in the app's
-- own model (every consumer assumes 14 CFR implicitly), and these are a
-- genuinely different regulatory family (DOT-wide, not FAA-specific) even
-- though the UI folds them into the same screen.
--
-- Tier: FREE, matching far_sections/far_parts exactly (open RLS, full
-- grants to anon+authenticated) -- NTSB/TSA/HMR content here is binding
-- federal law, same as FAR/AIM/P-CG (which are all free), not advisory
-- material the way AC/AD are (Plus-gated). This is a real product call,
-- not an obviously-forced one -- flagged to RC, easy to flip to Plus-gated
-- later (mirror advisory_circulars_gated's has_plus_access() pattern) if
-- that turns out to be wrong.
CREATE TABLE public.cfr49_parts (
  part text PRIMARY KEY,
  label text NOT NULL,
  -- Which agency/regulatory family this part belongs to, for the FAR/HMR/
  -- NTSB/TSA chip filter in far/index.tsx -- Title 49 spans many different
  -- agencies (PHMSA for hazmat, NTSB, TSA, FMCSA, FRA, etc.), this is NOT
  -- derivable from the part number alone.
  family text NOT NULL CHECK (family IN ('HMR', 'NTSB', 'TSA')),
  sort_order integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cfr49_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_number text NOT NULL UNIQUE,
  part text NOT NULL REFERENCES public.cfr49_parts(part),
  subpart_letter text,
  subpart_title text,
  title text,
  body_text text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section_number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) STORED,
  last_amended date,
  last_amended_is_floor boolean NOT NULL DEFAULT false
);

CREATE INDEX cfr49_sections_part_idx ON public.cfr49_sections(part);
CREATE INDEX cfr49_sections_search_vector_idx ON public.cfr49_sections USING gin(search_vector);

ALTER TABLE public.cfr49_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cfr49_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cfr49_parts public read" ON public.cfr49_parts FOR SELECT USING (true);
CREATE POLICY "cfr49_sections public read" ON public.cfr49_sections FOR SELECT USING (true);

GRANT SELECT ON public.cfr49_parts TO anon, authenticated;
GRANT SELECT ON public.cfr49_sections TO anon, authenticated;
