-- Keep a P/CG cross-reference we cannot resolve, instead of discarding it (2026-08-31)
--
-- 42 P/CG terms currently render a page that contradicts itself. They have no
-- definition of their own (the FAA publishes them purely as a redirect), and
-- pcg/[id].tsx therefore renders:
--
--     "See related term below — no standalone definition."
--
-- ...with nothing below, because their see_refs array is empty. The user is
-- told to look at a related term that is not on the screen. Affected terms are
-- not obscure: WAAS, PBN, ADS-B, D-ATIS, ASDA, CWA, CWT, AFIS, ATO, SHF, TBM,
-- ACTIVE RUNWAY, CIRCLING APPROACH, CIRCLING MANEUVER, and 28 more.
--
-- WHY THEY ARE EMPTY. The FAA source does carry a real "See X" for 39 of the
-- 42 (verified by re-fetching every glossary page). pcg_scraper.py captures
-- both cross-reference shapes correctly. What removes them is
-- fix_pcg_see_refs.py, which resolves each ref against our own corpus and
-- DROPS whatever does not resolve -- deliberately, per its own header:
-- "Keeping a dead entry serves no purpose -- it's unclickable."
--
-- That reasoning is right about the LINK and wrong about the TEXT. Of the 39,
-- only 9 resolve to a term we carry. The other 30 point at something the FAA
-- names but does not define as its own glossary entry (ADS-B -> AUTOMATIC
-- DEPENDENT SURVEILLANCE-BROADCAST, ASDA -> ACCELERATE-STOP DISTANCE
-- AVAILABLE, CWA -> CENTER WEATHER ADVISORY and WEATHER ADVISORY, ATO -> AIR
-- TRAFFIC ORGANIZATION...). Those names are still the single most useful thing
-- we can show a reader who landed on an otherwise empty page -- they are what
-- the FAA itself prints there.
--
-- So: unlinkable is not the same as worthless. This column keeps the raw
-- target text so the app can render it as plain, honest, unlinked text.
-- see_refs keeps its existing contract exactly -- only resolvable, linkable
-- refs go there, so no dead links are introduced anywhere.

alter table public.pcg_terms
  add column if not exists see_refs_unresolved text[] not null default '{}';

comment on column public.pcg_terms.see_refs_unresolved is
  'Cross-reference targets the FAA publishes for this term that do NOT resolve to a term we carry. Rendered as plain unlinked text so a definition-less redirect entry still tells the reader where the FAA points. Populated by sync/fix_pcg_see_refs.py; see_refs stays link-only.';
