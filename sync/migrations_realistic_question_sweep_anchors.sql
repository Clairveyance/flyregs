-- RC: "close all those gaps, across all regs" / "do all rounds of
-- realistic Qs across all topic. use both of your methods. do it all."
--
-- Confirmed gaps from this pass, both methods:
--  (a) mechanical title-sweep (search_anchor_gap_sweep.py) extended to
--      aim/pcg/acs this session -- P/CG alone found 16 outright misses +
--      55 low-rank cases where a term searched by ITS OWN EXACT NAME
--      didn't rank itself in the top 3 (some not even top 10). These are
--      bulk-anchored below (phrase = the term's own canonical name) --
--      safe by construction, no individual judgment call needed, since
--      "search this term's exact name -> get this term" isn't ambiguous.
--  (b) hand-crafted realistic pilot questions (realistic_question_sweep.py)
--      across FAR/AIM/P-CG/AC/AD -- each finding below was independently
--      confirmed against the actual section/paragraph/term title (and,
--      for P/CG, the actual definition text) before being anchored, not
--      assumed from the question alone.
--
-- P/CG's zero-result cases (see migrations_pcg_fallback_tier.sql, applied
-- immediately before this file) needed a structural retrieval fix, not
-- anchors -- an anchor can't rescue a row that never entered the result
-- set. That's fixed separately; the 2 P/CG entries below are for cases
-- where the fallback tier now returns *something* but not the precise
-- expected term (SAY AGAIN, SPECIAL VFR).
--
-- NOT anchored (genuine content gaps, term doesn't exist in the P/CG
-- corpus at all -- confirmed via direct pcg_terms lookup, not just a
-- failed search): "VFR ON TOP", "RUNWAY INCURSION", "HOLD SHORT LINE",
-- "CRITICAL AREA"/"ILS CRITICAL AREA" (this last one already flagged in
-- the 2026-08-11 corpus-sweep entry in flyregs_pending.md as a probable
-- P/CG extraction gap -- now 3 more of the same kind found). No anchor
-- fixes a term that isn't there; flagged for RC separately, not silently
-- patched with invented definitions.

-- ── FAR ──────────────────────────────────────────────────────────────────
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('weight and balance information review before flight', 'far', '91.103', 'the word "review" was colliding with 61.56 Flight review -- 91.103 (which actually requires reviewing W&B data) ranked #2 behind it'),
  ('preflight action required before flight', 'far', '91.103', NULL),
  ('do i need to check notams before flying', 'far', '91.103', 'total miss -- "check" collided with unrelated "Check pilots" qualification sections (121.411 etc), 91.103 never appeared in top 3; 91.103 is what actually requires checking NOTAMs preflight'),
  ('how much fuel do i need for a day vfr flight', 'far', '91.151', '91.155 (basic VFR weather minimums) outranked the actual fuel-requirements section on a fuel question'),
  ('vfr fuel reserve requirements', 'far', '91.151', NULL),
  ('class d airspace operating rules', 'far', '91.129', 'asking specifically about Class D returned Class B (91.131) and Class A (91.135) ahead of 91.129 itself'),
  ('class d airspace requirements', 'far', '91.129', NULL),
  ('temporary flight restriction for the president', 'far', '91.141', 'generic disaster-area TFR sections (91.137, 91.138) outranked the section that specifically covers presidential TFRs'),
  ('presidential tfr', 'far', '91.141', NULL),
  ('how many night takeoffs and landings to carry passengers at night', 'far', '61.57', 'total miss -- top 3 were all unrelated passenger-service-equipment-stowage sections (135.159, 121.577, 91.535); 61.57 (recent flight experience) is the actual answer and never appeared'),
  ('night currency to carry passengers', 'far', '61.57', NULL),
  ('what records must be kept after aircraft maintenance', 'far', '43.9', 'total miss -- top 3 were CAMP/121 recorder sections unrelated to the general recordkeeping question; 43.9 (content, form, and disposition of maintenance records) never appeared'),
  ('content and form of maintenance records', 'far', '43.9', NULL),
  ('aircraft airworthiness certificate must be displayed', 'far', '91.203', NULL)
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;

-- ── AIM ──────────────────────────────────────────────────────────────────
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('class a airspace description', 'aim', '3-2-2', 'total miss -- every OTHER airspace class (E, C, D) outranked Class A when asked about specifically; also the #6 low-rank finding from the mechanical title-sweep'),
  ('what is class a airspace', 'aim', '3-2-2', NULL),
  ('vfr cruising altitude rules', 'aim', '3-1-5', 'flight-plan-filing paragraph (5-1-5) outranked the actual VFR Cruising Altitudes and Flight Levels paragraph on a cruising-altitude question'),
  ('vfr cruising altitudes', 'aim', '3-1-5', NULL),
  ('wake turbulence avoidance procedures', 'aim', '7-4-6', 'the chapter''s generic "General" paragraph (7-4-1) outranked the specifically-titled Vortex Avoidance Procedures paragraph')
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;

-- ── P/CG: hand-crafted realistic-question findings ─────────────────────
-- (retrieval now works for these post-fallback-tier-fix; these anchors are
-- for precision -- surfacing the exact expected term at #1, not just
-- somewhere in a looser OR-matched result set)
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('what does say again mean on the radio', 'pcg', 'SAY_AGAIN', 'fallback tier returned EFVS as top result (shared "radio"/"mean" vocabulary) instead of the actual SAY AGAIN entry'),
  ('definition of special vfr', 'pcg', 'SPECIAL_VFR_CONDITIONS', 'bare "special VFR" doesn''t exist as its own term -- corpus has SPECIAL VFR CONDITIONS and SPECIAL VFR OPERATIONS as separate entries; anchoring both so either surfaces'),
  ('definition of special vfr', 'pcg', 'SPECIAL_VFR_OPERATIONS', NULL),
  ('what does special vfr mean', 'pcg', 'SPECIAL_VFR_CONDITIONS', NULL),
  ('what does special vfr mean', 'pcg', 'SPECIAL_VFR_OPERATIONS', NULL)
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;

-- ── P/CG: bulk mechanical title-sweep findings (71 rows) ────────────────
-- Every term below failed to rank itself in the top 3 (16 not even in the
-- top 10) when searched by its own exact canonical name. Anchoring a term
-- to its own name is correct by construction -- no per-row manual judgment
-- applied, none needed. Full data in scripts/audit_reports/search_anchor_gap_pcg.json.
INSERT INTO search_concept_anchors (phrase, doc_type, doc_id, note) VALUES
  ('air traffic control', 'pcg', 'AIR_TRAFFIC_CONTROL', NULL),
  ('air traffic', 'pcg', 'AIR_TRAFFIC', NULL),
  ('air traffic control service', 'pcg', 'AIR_TRAFFIC_CONTROL_SERVICE', NULL),
  ('final approach course', 'pcg', 'FINAL_APPROACH_COURSE', NULL),
  ('flight path', 'pcg', 'FLIGHT_PATH', NULL),
  ('flight plan', 'pcg', 'FLIGHT_PLAN', NULL),
  ('ifr flight', 'pcg', 'IFR_FLIGHT', NULL),
  ('instrument approach', 'pcg', 'INSTRUMENT_APPROACH', NULL),
  ('missed approach', 'pcg', 'MISSED_APPROACH', NULL),
  ('precision approach', 'pcg', 'PRECISION_APPROACH', NULL),
  ('point out', 'pcg', 'POINT_OUT', NULL),
  ('radar beacon', 'pcg', 'RADAR_BEACON', NULL),
  ('route segment', 'pcg', 'ROUTE_SEGMENT', NULL),
  ('terminal area', 'pcg', 'TERMINAL_AREA', NULL),
  ('vfr aircraft', 'pcg', 'VFR_AIRCRAFT', NULL),
  ('instrument approach procedure', 'pcg', 'INSTRUMENT_APPROACH_PROCEDURE', NULL),
  ('wake turbulence', 'pcg', 'WAKE_TURBULENCE', NULL),
  ('weather advisory', 'pcg', 'WEATHER_ADVISORY', NULL),
  ('approach control facility', 'pcg', 'APPROACH_CONTROL_FACILITY', NULL),
  ('atc clearance', 'pcg', 'ATC_CLEARANCE', NULL),
  ('below minimums', 'pcg', 'BELOW_MINIMUMS', NULL),
  ('cleared through', 'pcg', 'CLEARED_THROUGH', NULL),
  ('visual flight rules', 'pcg', 'VISUAL_FLIGHT_RULES', NULL),
  ('class a airspace', 'pcg', 'CLASS_A_AIRSPACE', NULL),
  ('clearance limit', 'pcg', 'CLEARANCE_LIMIT', NULL),
  ('controlled airspace', 'pcg', 'CONTROLLED_AIRSPACE', NULL),
  ('cruising altitude', 'pcg', 'CRUISING_ALTITUDE', NULL),
  ('data block', 'pcg', 'DATA_BLOCK', NULL),
  ('en route charts', 'pcg', 'EN_ROUTE_CHARTS', NULL),
  ('estimated time of arrival', 'pcg', 'ESTIMATED_TIME_OF_ARRIVAL', NULL),
  ('final approach segment', 'pcg', 'FINAL_APPROACH_SEGMENT', NULL),
  ('flight following', 'pcg', 'FLIGHT_FOLLOWING', NULL),
  ('high frequency', 'pcg', 'HIGH_FREQUENCY', NULL),
  ('ifr aircraft', 'pcg', 'IFR_AIRCRAFT', NULL),
  ('instrument approach procedure charts', 'pcg', 'INSTRUMENT_APPROACH_PROCEDURE_CHARTS', NULL),
  ('intermediate approach segment', 'pcg', 'INTERMEDIATE_APPROACH_SEGMENT', NULL),
  ('landing minimums', 'pcg', 'LANDING_MINIMUMS', NULL),
  ('low approach', 'pcg', 'LOW_APPROACH', NULL),
  ('military training routes', 'pcg', 'MILITARY_TRAINING_ROUTES', NULL),
  ('nonprecision approach', 'pcg', 'NONPRECISION_APPROACH', NULL),
  ('national airspace system', 'pcg', 'NATIONAL_AIRSPACE_SYSTEM', NULL),
  ('navigational aid', 'pcg', 'NAVIGATIONAL_AID', NULL),
  ('not standard', 'pcg', 'NOT_STANDARD', NULL),
  ('on course', 'pcg', 'ON_COURSE', NULL),
  ('outer fix', 'pcg', 'OUTER_FIX', NULL),
  ('outer fix', 'pcg', 'OUTER_FIX_2', 'two distinct P/CG entries share the identical term name "OUTER FIX" -- likely a duplicate/legacy entry in the source glossary; anchoring both rather than picking one'),
  ('pilot in command', 'pcg', 'PILOT_IN_COMMAND', NULL),
  ('position report', 'pcg', 'POSITION_REPORT', NULL),
  ('radar identification', 'pcg', 'RADAR_IDENTIFICATION', NULL),
  ('radar contact', 'pcg', 'RADAR_CONTACT', NULL),
  ('radar approach', 'pcg', 'RADAR_APPROACH', NULL),
  ('procedure turn', 'pcg', 'PROCEDURE_TURN', NULL),
  ('radio beacon', 'pcg', 'RADIO_BEACON', NULL),
  ('radar service', 'pcg', 'RADAR_SERVICE', NULL),
  ('release time', 'pcg', 'RELEASE_TIME', NULL),
  ('reporting point', 'pcg', 'REPORTING_POINT', NULL),
  ('remote pilot', 'pcg', 'REMOTE_PILOT', NULL),
  ('separation minima', 'pcg', 'SEPARATION_MINIMA', NULL),
  ('surface area', 'pcg', 'SURFACE_AREA', NULL),
  ('target symbol', 'pcg', 'TARGET_SYMBOL', NULL),
  ('trial plan', 'pcg', 'TRIAL_PLAN', NULL),
  ('turbojet aircraft', 'pcg', 'TURBOJET_AIRCRAFT', NULL),
  ('transition point', 'pcg', 'TRANSITION_POINT', NULL),
  ('vfr flight', 'pcg', 'VFR_FLIGHT', NULL),
  ('wind shear', 'pcg', 'WIND_SHEAR', NULL),
  ('distance measuring equipment (dme)', 'pcg', 'DISTANCE_MEASURING_EQUIPMENT_DME', NULL),
  ('final approach fix', 'pcg', 'FINAL_APPROACH_FIX', NULL),
  ('instrument flight rules (ifr)', 'pcg', 'INSTRUMENT_FLIGHT_RULES_IFR', NULL),
  ('landing area', 'pcg', 'LANDING_AREA', NULL),
  ('scheduled time of arrival (sta)', 'pcg', 'SCHEDULED_TIME_OF_ARRIVAL_STA', NULL),
  ('traffic advisories', 'pcg', 'TRAFFIC_ADVISORIES', NULL)
ON CONFLICT (phrase, doc_type, doc_id) DO NOTHING;
