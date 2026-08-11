-- RC: "we need another full sweep of all PC/G terms, cross-ref w/ FAA, and
-- do a full internet search." Downloaded the CURRENT official FAA
-- Pilot/Controller Glossary (effective 7/9/26, Change 3, 1304 terms) from
-- faa.gov/air_traffic/publications/atpubs/pcg_html/ and diffed every term
-- name against pcg_terms (1332 rows). See memory/pcg_corpus_content_gaps.md
-- for the corrected finding this sweep produced -- the 4 terms flagged
-- missing in an earlier pass (VFR ON TOP, RUNWAY INCURSION, HOLD SHORT
-- LINE, CRITICAL AREA) turned out to NOT be in the current official
-- glossary either, so they were never a FlyRegs extraction gap.
--
-- This sweep found ~32 official terms with no match in our corpus.
-- Cross-referencing each one's own "See X" redirect (where the official
-- glossary itself treats it as an alias) against our corpus resolved
-- most of them as already covered under the target term's full name --
-- e.g. official "TDZE" is itself just a stub redirecting to "TOUCHDOWN
-- ZONE ELEVATION", which we already have. Those cases are anchor-only
-- fixes below (search "TDZE" -> find our existing TOUCHDOWN_ZONE_ELEVATION
-- entry), not new rows -- adding a duplicate row for an official redirect
-- stub would fragment the corpus, not complete it.
--
-- 7 terms had a real, standalone, substantive definition in the official
-- glossary with NO corresponding content anywhere in our corpus -- these
-- are genuine content gaps, added below verbatim from the official source
-- (not paraphrased) per the data-accuracy standing rule.
--
-- NOT resolved in this pass (excluded rather than guessed): TODA, TORA,
-- TVOR's own redirect targets ("TAKEOFF DISTANCE AVAILABLE", "TAKEOFF RUN
-- AVAILABLE", the VOR-station target) couldn't be reliably located in the
-- source HTML's markup (inconsistent id attributes across entries) --
-- excluded rather than risk adding wrong/duplicate content. Also excluded:
-- SATELLITE, AIR TRAFFIC SERVICE (bare, vs. the ATS ROUTES variant added
-- below), TRAFFIC INFORMATION -- all have SOME related coverage already
-- and the official entries' own extracted text was incomplete/ambiguous
-- in this pass.

-- ── 7 genuine content gaps: real definitions, verbatim from the current
--    official glossary ──────────────────────────────────────────────────
INSERT INTO pcg_terms (slug, term, letter, definition) VALUES
  ('AIR_TRAFFIC_SERVICE_ATS_ROUTES', 'AIR TRAFFIC SERVICE (ATS) ROUTES', 'A',
   'The term "ATS Route" is a generic term that includes "VOR Federal airways," "colored Federal airways," "jet routes," and "RNAV routes." The term "ATS route" does not replace these more familiar route names, but serves only as an overall title when listing the types of routes that comprise the United States route structure.'),
  ('GROSS_NAVIGATION_ERROR_GNE', 'GROSS NAVIGATION ERROR (GNE)', 'G',
   'A lateral deviation of 10 NM or more from the aircraft''s cleared route.'),
  ('PREFERRED_IFR_ROUTES', 'PREFERRED IFR ROUTES', 'P',
   'Routes established between busier airports to increase system efficiency and capacity. They normally extend through one or more ARTCC areas and are designed to achieve balanced traffic flows among high density terminals. IFR clearances are issued on the basis of these routes except when severe weather avoidance procedures or other factors dictate otherwise. Preferred IFR Routes are listed in the Chart Supplement U.S.'),
  ('SECURITY_SERVICES_AIRSPACE', 'SECURITY SERVICES AIRSPACE', 'S',
   'Areas established through the regulatory process or by NOTAM, issued by the Administrator under title 14, CFR, sections 99.7, 91.141, and 91.139, which specify that ATC security services are required; i.e., ADIZ or temporary flight rules areas.'),
  ('TAKEOFF_ROLL', 'TAKEOFF ROLL', 'T',
   'The process whereby an aircraft is aligned with the runway centerline and the aircraft is moving with the intent to take off. For helicopters, this pertains to the act of becoming airborne after departing a takeoff area.'),
  ('TEMPORARY_FLIGHT_RESTRICTION_TFR', 'TEMPORARY FLIGHT RESTRICTION (TFR)', 'T',
   'A TFR is a regulatory action issued by the FAA via the U.S. NOTAM System, under the authority of United States Code, Title 49. TFRs are issued within the sovereign airspace of the United States and its territories to restrict certain aircraft from operating within a defined area on a temporary basis to protect persons or property in the air or on the ground. While not all inclusive, TFRs may be issued for disaster or hazard situations such as: toxic gas leaks or spills, fumes from flammable agents, aircraft accident/incident sites, aviation or ground resources engaged in wildfire suppression, or aircraft relief activities following a disaster. TFRs may also be issued in support of VIP movements, for reasons of national security; or when determined necessary for the management of air traffic in the vicinity of aerial demonstrations or major sporting events. NAS users or other interested parties should contact a FSS for TFR information. Additionally, TFR information can be found in automated briefings, NOTAM publications, and on the internet at https://www.faa.gov. The FAA also distributes TFR information to aviation user groups for further dissemination.'),
  ('TRANSPONDER_OBSERVED', 'TRANSPONDER OBSERVED', 'T',
   'Phraseology used to inform a VFR pilot the aircraft''s assigned beacon code and position have been observed. Specifically, this term conveys to a VFR pilot the transponder reply has been observed and its position correlated for transit through the designated area.')
ON CONFLICT (slug) DO NOTHING;

-- ── Anchors: official abbreviation/synonym redirects to terms we already
--    have, where the abbreviation doesn't literally appear in the target
--    term's own name (so plain lexical search wouldn't connect them) ────
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('tdze', 'pcg', 'TOUCHDOWN_ZONE_ELEVATION', 'official glossary redirects the abbreviation TDZE here'),
  ('takeoff area', 'pcg', 'LANDING_AREA', 'official glossary treats "takeoff area" as a synonym redirect to LANDING AREA'),
  ('threshold lights', 'pcg', 'AIRPORT_LIGHTING', 'official glossary redirects here'),
  ('tmpa', 'pcg', 'TRAFFIC_MANAGEMENT_PROGRAM_ALERT', 'official glossary redirects the abbreviation TMPA here'),
  ('tmu', 'pcg', 'TRAFFIC_MANAGEMENT_UNIT', 'official glossary redirects the abbreviation TMU here'),
  ('touchdown rvr', 'pcg', 'VISIBILITY', 'official glossary redirects here'),
  ('touchdown zone lighting', 'pcg', 'AIRPORT_LIGHTING', 'official glossary redirects here'),
  ('tower to tower', 'pcg', 'TOWER_EN_ROUTE_CONTROL_SERVICE', 'official glossary redirects here'),
  ('transferring facility', 'pcg', 'TRANSFERRING_CONTROLLER', 'official glossary redirects here'),
  ('transponder codes', 'pcg', 'CODES', 'official glossary redirects here'),
  ('tch', 'pcg', 'THRESHOLD_CROSSING_HEIGHT', 'official glossary redirects the abbreviation TCH here')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
