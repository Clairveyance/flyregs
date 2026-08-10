-- Follow-up to the G1000/King Air false-positive fix (2026-08-09), resumed
-- 2026-08-10 per RC's "keep going on your prev work. AD part tags, etc."
--
-- Read each of the 4 flagged ADs' real applicability/subject/reason text to
-- determine, per AD, whether the tagged "part" is the AD's actual defective
-- component or just an applicability-qualifying precondition mistakenly
-- extracted by extract_ad_parts.py's LLM prompt (which is meant to catch
-- parts an AD is KEYED TO regardless of airframe, like the AWI-muffler
-- example, not equipment that merely determines which serial-number
-- sub-fleet is in scope):
--
-- 2020-22-13 (AHCAS): KEPT, no change. AHCAS is genuinely the affected
-- system per its own Reason text (AHRS/flight-ground logic signal fault) --
-- a specific, Airbus-Helicopters-branded term, not a universal umbrella
-- like G1000. No narrower part exists to substitute; this tag is correct.
--
-- 2013-17-01 (Autopilot + Modification 071908 + Modification 073252):
-- DELETED all three. The AD's real Unsafe Condition is "a loose nut or
-- misaligned tail rotor control stop screw" -- completely unrelated to the
-- autopilot/modification numbers, which are only there to define WHICH
-- serial-number sub-fleet the applicability clause covers ("Model X
-- helicopters WITH AN AUTOPILOT installed", "Model Y WITH modification Z
-- installed"). None of the three tagged "parts" are the actual defect.
--
-- 2021-07-12 (Autopilot): DELETED. Subject is Rotorcraft Flight Control;
-- Reason is uncommanded main rotor trim actuator disengagement "during
-- flight with the autopilot engaged," fixed by "installing a cyclic stick
-- weight compensation modification" -- the real fix component is that
-- modification, not "Autopilot" generically, and applicability is tightly
-- scoped to specific EC135 serial numbers -- a bare "Autopilot" equipment
-- tag would false-match any unrelated aircraft with any autopilot brand.
--
-- 2024-14-03 (Garmin GFC 500 Autopilot System, sibling: GSA 28 Pitch Trim
-- Servo): DELETED the GFC 500 system-level tag, kept the servo. The AD's
-- own applicability text is explicit: "having a Garmin GFC 500 Autopilot
-- System THAT INCLUDES an optional GSA 28 pitch trim servo installed per
-- [STC]" -- a plain GFC 500 without that specific STC'd servo option is NOT
-- applicable. Exactly the G1000-shaped risk: the broader system tag would
-- false-match any GFC 500 owner regardless of whether they have the
-- specific servo STC that actually matters.
--
-- Zero real aircraft are currently affected by any of these four tags
-- (confirmed via direct query before this fix) -- this is a latent-risk
-- cleanup, not an active bug, matching the general lesson already recorded
-- in gotcha_ad_equipment_match_overbroad_parent_part.md. Verified after:
-- 2013-17-01 and 2021-07-12 have zero ad_part_mentions rows left (rely on
-- airframe/model matching only); 2020-22-13 keeps AHCAS; 2024-14-03 keeps
-- only GSA 28 Pitch Trim Servo. None of the four deleted part names are
-- used by any other AD.

delete from ad_part_mentions
where ad_number = '2013-17-01'
  and part_id in (select id from ad_parts where name in ('Autopilot', 'Modification 071908', 'Modification 073252'));

delete from ad_part_mentions
where ad_number = '2021-07-12'
  and part_id in (select id from ad_parts where name = 'Autopilot');

delete from ad_part_mentions
where ad_number = '2024-14-03'
  and part_id in (select id from ad_parts where name = 'Garmin GFC 500 Autopilot System');
