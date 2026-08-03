-- ============================================================================
-- P/CG knowledge-level classification: the 56 `frequently_used` terms
-- missing from pcg_term_levels                              2026-08-04
--
-- Found while auditing whether Study/Duels filtering "actually works"
-- (see PROJECT_NOTES/flyregs_pending.md latest+20): pcg_term_levels only
-- covered 487 of 926 studyable P/CG terms, and pcg_knowledge_levels()
-- returns an empty array (not NULL) for anything missing, which the
-- existing "exclude unclassified from a level-filtered pool" convention
-- (deliberate, same as FAR/AIM/AC) then silently drops entirely -- 56 of
-- the 526 missing terms are flagged `frequently_used`, i.e. presumed
-- genuinely important, not obscure edge cases.
--
-- RC's own theory, checked against the real definitions before writing
-- anything: "if most terms aren't used in ACS/PTS tests, we don't really
-- need to quiz on them." Does NOT hold for this specific 56 -- they are
-- almost entirely standard FAA radio/ATC phraseology (MAYDAY, ROGER,
-- STAND BY, WILCO, EMERGENCY...) that every certificate level is tested
-- on starting with student ground school, plus a smaller coherent group
-- of instrument-approach/radar-vectoring procedure terms (CRUISE, CROSS
-- (FIX) AT..., EXECUTE MISSED APPROACH, NO GYRO APPROACH...) that match
-- the exact "private+" bucket AIM 5-4 (Instrument Approach Procedures)
-- already established for the same reason
-- (gotcha_aim_chapter_level_too_coarse) -- these are real IFR-clearance/
-- procedure phraseology, not tested at the Student level.
--
-- Classified by hand from each term's actual FAA Pilot/Controller
-- Glossary definition (pulled live, not guessed from the term name) --
-- this is standardized, well-documented content with one settled meaning
-- each, not ambiguous judgment calls, so no LLM classification pass was
-- needed for this batch.
--
-- One term deliberately left unclassified: STOP_STREAM ("Used by ATC to
-- request a pilot to suspend electronic attack activity") is a genuine
-- military electronic-warfare instruction with no real ACS/PTS relevance
-- for a normal certificate track -- exactly the kind of term RC's own
-- reasoning correctly says doesn't need forcing into a level bucket.
--
-- NOT done in this pass: the remaining ~471 non-frequently_used
-- unclassified P/CG terms. Spot-checked a random sample of 40 separately
-- -- a genuine mixed bag, not a clean "safe to skip" or "must fix" answer
-- either way: many are legitimately niche (military/carrier-ops terms
-- like PHOTO RECONNAISSANCE, MANPADS, AUTOMATIC CARRIER LANDING SYSTEM;
-- ATC-facility-internal jargon like SURFACE METERING PROGRAM, CONTROL
-- SLASH, STRATEGIC PLANNING), consistent with RC's "doesn't matter" read
-- -- but a real minority look like genuine pilot vocabulary (UNICOM,
-- UAWP, TCAS, FLY HEADING (DEGREES), FINAL APPROACH POINT) that just
-- wasn't flagged frequently_used. Recommendation delivered to RC directly
-- (not encoded here): given the mixed value and that unclassified already
-- means "correctly excluded from level filters" (the same steady state
-- FAR/AC mechanic-only content already sits in on purpose), skip a full
-- pass on the remainder rather than spend on it -- offered a real,
-- inexpensive LLM classification estimate if RC wants full coverage
-- anyway, not run.
-- ============================================================================

insert into pcg_term_levels (slug, levels) values
  ('ABEAM', array['student','private','commercial','atp','cfi']),
  ('ABORT', array['student','private','commercial','atp','cfi']),
  ('ACKNOWLEDGE', array['student','private','commercial','atp','cfi']),
  ('AFFIRMATIVE', array['student','private','commercial','atp','cfi']),
  ('ALTITUDE_READOUT', array['student','private','commercial','atp','cfi']),
  ('BLOCKED', array['student','private','commercial','atp','cfi']),
  ('CHASE', array['student','private','commercial','atp','cfi']),
  ('CONTINUE', array['student','private','commercial','atp','cfi']),
  ('DIRECT', array['student','private','commercial','atp','cfi']),
  ('EMERGENCY', array['student','private','commercial','atp','cfi']),
  ('EXPEDITE', array['student','private','commercial','atp','cfi']),
  ('FINAL', array['student','private','commercial','atp','cfi']),
  ('GO_AHEAD', array['student','private','commercial','atp','cfi']),
  ('HOMING', array['student','private','commercial','atp','cfi']),
  ('I_SAY_AGAIN', array['student','private','commercial','atp','cfi']),
  ('IDENT', array['student','private','commercial','atp','cfi']),
  ('IMMEDIATELY', array['student','private','commercial','atp','cfi']),
  ('MAKE_SHORT_APPROACH', array['student','private','commercial','atp','cfi']),
  ('MAYDAY', array['student','private','commercial','atp','cfi']),
  ('MONITOR', array['student','private','commercial','atp','cfi']),
  ('NEGATIVE', array['student','private','commercial','atp','cfi']),
  ('NEGATIVE_CONTACT', array['student','private','commercial','atp','cfi']),
  ('NUMEROUS_TARGETS_VICINITY_LOCATION', array['student','private','commercial','atp','cfi']),
  ('OUT', array['student','private','commercial','atp','cfi']),
  ('OVER', array['student','private','commercial','atp','cfi']),
  ('REPORT', array['student','private','commercial','atp','cfi']),
  ('ROGER', array['student','private','commercial','atp','cfi']),
  ('SAY_AGAIN', array['student','private','commercial','atp','cfi']),
  ('SAY_ALTITUDE', array['student','private','commercial','atp','cfi']),
  ('SAY_HEADING', array['student','private','commercial','atp','cfi']),
  ('SIGMET', array['student','private','commercial','atp','cfi']),
  ('SPEAK_SLOWER', array['student','private','commercial','atp','cfi']),
  ('STAND_BY', array['student','private','commercial','atp','cfi']),
  ('THAT_IS_CORRECT', array['student','private','commercial','atp','cfi']),
  ('TRAFFIC_NO_FACTOR', array['student','private','commercial','atp','cfi']),
  ('TRAFFIC_NO_LONGER_OBSERVED', array['student','private','commercial','atp','cfi']),
  ('UNABLE', array['student','private','commercial','atp','cfi']),
  ('VERIFY', array['student','private','commercial','atp','cfi']),
  ('VFR_NOT_RECOMMENDED', array['student','private','commercial','atp','cfi']),
  ('WILCO', array['student','private','commercial','atp','cfi']),
  ('APPROPRIATE_OBSTACLE_CLEARANCE_MINIMUM_ALTITUDE', array['private','commercial','atp','cfi']),
  ('APPROPRIATE_TERRAIN_CLEARANCE_MINIMUM_ALTITUDE', array['private','commercial','atp','cfi']),
  ('CIRCLE_TO_RUNWAY_RUNWAY_NUMBER', array['private','commercial','atp','cfi']),
  ('CLEARANCE_VOID_IF_NOT_OFF_BY_TIME', array['private','commercial','atp','cfi']),
  ('COMPLY_WITH_RESTRICTIONS', array['private','commercial','atp','cfi']),
  ('CROSS_FIX_AT_ALTITUDE', array['private','commercial','atp','cfi']),
  ('CROSS_FIX_AT_OR_ABOVE_ALTITUDE', array['private','commercial','atp','cfi']),
  ('CROSS_FIX_AT_OR_BELOW_ALTITUDE', array['private','commercial','atp','cfi']),
  ('CRUISE', array['private','commercial','atp','cfi']),
  ('DELAY_INDEFINITE_REASON_IF_KNOWN_EXPECT_FURTHER_CLEARANCE_TIME', array['private','commercial','atp','cfi']),
  ('EXECUTE_MISSED_APPROACH', array['private','commercial','atp','cfi']),
  ('IF_NO_TRANSMISSION_RECEIVED_FOR_TIME', array['private','commercial','atp','cfi']),
  ('NO_GYRO_APPROACH', array['private','commercial','atp','cfi']),
  ('RESUME_OWN_NAVIGATION', array['private','commercial','atp','cfi']),
  ('VERIFY_SPECIFIC_DIRECTION_OF_TAKEOFF_OR_TURNS_AFTER_TAKEOFF', array['private','commercial','atp','cfi'])
on conflict (slug) do update set levels = excluded.levels;

-- Verified live: pcg_term_levels rows 487 -> 542 (55 inserted, STOP_STREAM
-- correctly excluded); still-missing count 526 -> 471.
