"""Hand-authored Instrument-rating question bank.

Same rules as the Private batch: every question written against text read from
far_sections.body_text, never from memory, and the loader refuses any question
whose supporting text cannot be quoted.

The Instrument box was the thinnest of all nine before the Dictionary wiring
(79 items corpus-wide), and it maps to only 18 core FAR sections, so these are
dense on the sections that matter rather than spread thin.
"""

# (item_id, category, q_type, question, answer, [3 distractors], explanation)
Q = [
# ── Instrument Rating Requirements ─────────────────────────────────────────
("61.65", "Instrument Rating Requirements", "recall",
 "How much cross-country PIC time is required for an instrument-airplane rating?",
 "50 hours, of which 10 hours must be in an airplane",
 ["40 hours, of which 10 must be in an airplane", "50 hours, all of which must be in an airplane",
  "25 hours, of which 10 must be in an airplane"],
 "61.65(d)(1). The 50 hours is cross-country time AS PIC -- distinct from the 40 hours of instrument time in (d)(2). Confusing the two is the single most common error on this section."),

("61.65", "Instrument Rating Requirements", "recall",
 "How much actual or simulated instrument time is required, and how much must come from an instructor?",
 "40 hours total, of which 15 hours must be from an authorized instructor with an instrument-airplane rating",
 ["40 hours total, of which 20 must be from an instructor",
  "50 hours total, of which 15 must be from an instructor",
  "25 hours total, of which 15 must be from an instructor"],
 "61.65(d)(2). Note the instructor must hold an instrument-AIRPLANE rating for the airplane rating -- a CFI without the instrument rating cannot give this training."),

("61.65", "Instrument Rating Requirements", "recall",
 "What are the requirements of the long IFR cross-country for the instrument rating?",
 "250 nautical miles along airways or directed routing, an instrument approach at each airport, and three different kinds of approaches",
 ["150 nautical miles with three approaches", "250 nautical miles with one approach",
  "300 nautical miles with two different kinds of approaches"],
 "61.65(d)(2)(ii). All three conditions apply together, the flight must be flown under IFR with a flight plan filed, and it must be with an authorized instructor."),

("61.65", "Instrument Rating Requirements", "recall",
 "How recently before the practical test must the 3 hours of instrument flight training be accomplished?",
 "Within 2 calendar months before the date of the practical test",
 ["Within 60 days", "Within 6 calendar months", "There is no recency requirement"],
 "61.65(d)(2)(i). 'Calendar months' again, not days -- training in early March counts through the end of May. This is a test-prep recency rule, separate from the 40-hour total."),

("61.65", "Instrument Rating Requirements", "recall",
 "What certificate must an instrument rating applicant hold?",
 "At least a current private pilot certificate, or be concurrently applying for one, with an appropriate category rating",
 ["A commercial pilot certificate", "A student pilot certificate is sufficient",
  "Any certificate plus 100 hours total time"],
 "61.65(a)(1). The 'concurrently applying' clause is what allows a combined private/instrument course to finish both at once."),

# ── IFR Currency & Experience ──────────────────────────────────────────────
("61.57", "IFR Currency & Experience", "recall",
 "What instrument experience is required to act as PIC under IFR?",
 "Within the preceding 6 calendar months: six instrument approaches, holding procedures and tasks, and intercepting and tracking courses",
 ["Within the preceding 90 days: six approaches and holding",
  "Within the preceding 12 calendar months: six approaches and holding",
  "Within the preceding 6 calendar months: three approaches and holding"],
 "61.57(c)(1). The memory aid is 6-6-HIT: six approaches in six calendar months, plus Holding, Intercepting and Tracking. All three task types are required, not just the approaches."),

("61.57", "IFR Currency & Experience", "scenario",
 "You flew six approaches in a certified aviation training device rather than an aircraft. Does this maintain instrument currency?",
 "Yes -- the tasks may be done in a full flight simulator, flight training device, or aviation training device representing the category",
 ["No, they must all be in an actual aircraft", "Only if an instructor was present",
  "Only three of the six may be done in a device"],
 "61.57(c)(2) permits any combination of aircraft and devices, provided the device represents the CATEGORY of aircraft for the rating being maintained and the tasks are done in simulated instrument conditions."),

("61.57", "IFR Currency & Experience", "scenario",
 "It is 20 March. Your last six approaches, holding, and course tracking were logged on 5 September of last year. Are you instrument current?",
 "Yes -- 6 calendar months preceding March reaches back to September",
 ["No, currency lapsed on 5 March", "No, currency lapsed at the end of February",
  "Only if you also had a flight review"],
 "61.57(c)(1) counts the 6 calendar months PRECEDING the month of the flight, so a March flight looks back through September. Reading it as 'six months to the day' from 5 September would wrongly retire you two weeks early."),

# ── IFR Fuel Requirements ──────────────────────────────────────────────────
("91.167", "IFR Fuel Requirements", "recall",
 "What fuel is required for a flight in IFR conditions?",
 "Enough to fly to the first airport of intended landing, then to the alternate, then 45 minutes at normal cruising speed",
 ["To the destination plus 30 minutes", "To the destination plus 45 minutes, no alternate fuel",
  "To the destination, the alternate, then 30 minutes"],
 "91.167(a). Helicopters get 30 minutes rather than 45. The alternate leg drops out only when the 91.167(b) weather test is met."),

("91.167", "IFR Fuel Requirements", "scenario",
 "Your destination has a published approach and the forecast shows a 2,500-foot ceiling and 4 miles visibility from 1 hour before to 1 hour after ETA. Must you carry alternate fuel?",
 "No -- the forecast beats 2,000 feet and 3 statute miles, so the alternate fuel requirement does not apply",
 ["Yes, alternate fuel is always required under IFR",
  "Yes, unless the ceiling is at least 3,000 feet",
  "No, but only if you also file no alternate"],
 "91.167(b): with a published approach and a forecast of at least 2,000-foot ceiling and 3 statute miles for the window 1 hour either side of ETA, the alternate leg is not required. This is the fuel side of the same '1-2-3' test that governs filing an alternate in 91.169."),

# ── IFR Flight Planning & Alternates ───────────────────────────────────────
("91.169", "IFR Flight Planning & Alternates", "recall",
 "When must an alternate airport be listed on an IFR flight plan?",
 "Always, unless the destination has a published approach and the forecast shows at least 2,000-foot ceiling and 3 statute miles from 1 hour before to 1 hour after ETA",
 ["Only when the destination forecast is below 1,000 feet and 3 miles",
  "Only for flights longer than 2 hours", "An alternate is never required for Part 91"],
 "91.169(a)(2) and (b). This is the '1-2-3 rule': 1 hour either side of ETA, 2,000-foot ceiling, 3 statute miles. Helicopters use a different test in (b)(2)(ii)."),

("91.169", "IFR Flight Planning & Alternates", "recall",
 "Absent published alternate minima, what standard minima apply to an alternate with a PRECISION approach?",
 "Ceiling 600 feet and visibility 2 statute miles",
 ["Ceiling 800 feet and visibility 2 statute miles", "Ceiling 600 feet and visibility 1 statute mile",
  "Ceiling 1,000 feet and visibility 3 statute miles"],
 "91.169(c)(1)(i)(A). Remember 600-2 for precision and 800-2 for non-precision. These are evaluated at the ESTIMATED TIME OF ARRIVAL at the alternate, and only apply when the procedure itself specifies no alternate minima."),

("91.169", "IFR Flight Planning & Alternates", "scenario",
 "You list an alternate whose only approach is a non-precision procedure with no published alternate minima. What weather must be forecast there at your ETA?",
 "Ceiling 800 feet and visibility 2 statute miles",
 ["Ceiling 600 feet and visibility 2 statute miles", "Ceiling 800 feet and visibility 1 statute mile",
  "Ceiling 1,000 feet and visibility 2 statute miles"],
 "91.169(c)(1)(i)(B). The 600-2 / 800-2 pair is the classic swap. Note these govern whether you may FILE the airport as an alternate -- once you actually divert there, you fly the approach's own published minima."),

# ── IFR Altitudes ──────────────────────────────────────────────────────────
("91.177", "IFR Altitudes", "recall",
 "Over a designated mountainous area with no prescribed minimum altitude, what is the IFR minimum?",
 "2,000 feet above the highest obstacle within 4 nautical miles of the course",
 ["1,000 feet above the highest obstacle within 4 nautical miles",
  "2,000 feet above the highest obstacle within 5 nautical miles",
  "1,500 feet above the highest obstacle within 4 nautical miles"],
 "91.177(a)(2)(i). Non-mountainous areas get 1,000 feet over the same 4 NM horizontal distance. Both apply only where parts 95 and 97 prescribe no minimum."),

("91.177", "IFR Altitudes", "scenario",
 "A route segment publishes both an MEA and a lower MOCA. May you fly at the MOCA?",
 "Yes, down to but not below the MOCA, provided the navigation signals are available -- within 22 NM of the VOR when using VOR navigation",
 ["No, the MEA is an absolute floor", "Yes, anywhere along the segment without restriction",
  "Only with an ATC clearance to do so"],
 "91.177(a)(1). The 22 NM figure is the tested detail and is based on the pilot's own reasonable estimate of that distance."),

("91.179", "IFR Altitudes", "recall",
 "In CONTROLLED airspace under IFR, what altitude must you maintain?",
 "The altitude or flight level assigned by ATC",
 ["Odd thousands eastbound, even thousands westbound",
  "Odd thousands plus 500 eastbound", "Any altitude above the MEA"],
 "91.179(a). The hemispheric rule applies to IFR only in UNCONTROLLED airspace (91.179(b)) -- or when ATC assigns 'VFR conditions on-top', which sends you back to 91.159's VFR altitudes."),

("91.179", "IFR Altitudes", "recall",
 "In UNCONTROLLED airspace under IFR below 18,000 MSL on a magnetic course of 090, what altitude is appropriate?",
 "Any odd thousand foot MSL altitude, such as 3,000, 5,000, or 7,000",
 ["Any odd thousand plus 500 feet, such as 3,500", "Any even thousand, such as 4,000",
  "Any even thousand plus 500 feet, such as 4,500"],
 "91.179(b)(1)(i). IFR uses whole thousands; VFR (91.159) adds the extra 500 feet. Flying an IFR altitude with +500 is a VFR altitude and vice versa."),

# ── Instrument Approaches ──────────────────────────────────────────────────
("91.175", "Instrument Approaches", "recall",
 "What three conditions must ALL be met to descend below DA/DH or MDA?",
 "A normal descent to landing is possible, flight visibility is at least the published minimum, and a required visual reference is distinctly visible",
 ["Only that the runway is in sight", "Only that flight visibility meets the published minimum",
  "Only that you are established on the final approach course"],
 "91.175(c). All three, together. The visibility test is FLIGHT visibility -- what you actually see from the cockpit -- not the reported ground visibility."),

("91.175", "Instrument Approaches", "scenario",
 "On approach you see only the approach light system. How low may you descend?",
 "To 100 feet above the touchdown zone elevation, unless the red terminating bars or red side row bars are also distinctly visible",
 ["To the MDA only", "All the way to touchdown on the approach lights alone",
  "To 200 feet above touchdown zone elevation"],
 "91.175(c)(3)(i). The approach light system alone buys you down to 100 feet above TDZE; going lower needs the red terminating bars or red side row bars, or one of the other listed references such as the threshold, runway markings, or REIL."),

# ── IFR Communications & Lost Comm ─────────────────────────────────────────
("91.185", "IFR Communications & Lost Comm", "recall",
 "If two-way radio failure occurs in VFR conditions under IFR, what must you do?",
 "Continue the flight under VFR and land as soon as practicable",
 ["Continue to the destination as filed and land",
  "Squawk 7600 and continue IFR to the filed destination",
  "Land immediately at the nearest airport"],
 "91.185(b). VFR conditions override the whole IFR lost-comm procedure. 'As soon as practicable' is a judgement call, deliberately not 'as soon as possible'."),

("91.185", "IFR Communications & Lost Comm", "recall",
 "Under IFR lost comm in IFR conditions, what altitude must you fly?",
 "The HIGHEST of: the last assigned altitude, the minimum IFR altitude for the segment, or the altitude ATC advised to expect",
 ["The last assigned altitude in all cases", "The minimum IFR altitude in all cases",
  "The lowest of the three"],
 "91.185(c)(2). The memory aid is MEA: Minimum, Expected, Assigned -- and you take the HIGHEST of them for each route segment, re-evaluated segment by segment."),

("91.185", "IFR Communications & Lost Comm", "recall",
 "Under IFR lost comm, what route should you fly?",
 "Assigned, then vectored, then expected, then filed -- in that order of precedence",
 ["Always the route filed in the flight plan", "Always direct to the destination",
  "Whatever route ATC last acknowledged, then direct"],
 "91.185(c)(1). The memory aid is AVEF: Assigned, Vectored, Expected, Filed. Route and altitude are decided independently -- AVEF for the route, highest-of-MEA for the altitude."),

("91.183", "IFR Communications & Lost Comm", "recall",
 "Under IFR in controlled airspace, what must the pilot report to ATC as soon as possible?",
 "Passing designated reporting points, any unforecast weather encountered, and other information relating to flight safety",
 ["Only position reports when requested", "Only weather deviations",
  "Only equipment malfunctions"],
 "91.183. Under radar control only the reporting points ATC specifically asks for need reporting -- but unforecast weather and safety-relevant information are always required."),

# ── IFR Equipment & Checks ─────────────────────────────────────────────────
("91.171", "IFR Equipment & Checks", "recall",
 "How recently must a VOR check have been performed to use VOR navigation under IFR?",
 "Within the preceding 30 days",
 ["Within the preceding 24 calendar months", "Within the preceding 90 days",
  "Within the preceding 12 calendar months"],
 "91.171(a)(2). Note this is 30 DAYS, not calendar months -- a rare exception in Part 91, which usually counts calendar months. The alternative is maintenance under an approved procedure per (a)(1)."),

("91.171", "IFR Equipment & Checks", "recall",
 "What is the maximum permissible bearing error using a VOT or a designated airport surface checkpoint?",
 "Plus or minus 4 degrees",
 ["Plus or minus 6 degrees", "Plus or minus 2 degrees", "Plus or minus 8 degrees"],
 "91.171(b)(1) and (b)(2). Ground checks allow 4 degrees; an airborne checkpoint allows 6, and a dual-VOR cross-check allows 4 degrees between the two systems. The record must show date, place, bearing error, and signature."),

("91.411", "IFR Equipment & Checks", "recall",
 "For IFR flight in controlled airspace, how recently must the altimeter and static system have been tested?",
 "Within the preceding 24 calendar months",
 ["Within the preceding 12 calendar months", "Within the preceding 30 days",
  "Within the preceding 48 calendar months"],
 "91.411(a)(1). Same 24-month clock as the transponder check in 91.413, which is why shops do them together -- but 91.411 is required only for IFR in controlled airspace, while 91.413 applies whenever the transponder is used at all."),

("91.205", "IFR Equipment & Checks", "recall",
 "Which instruments does 91.205(d) add for IFR beyond the day and night VFR lists?",
 "Two-way radio and navigation equipment, gyroscopic rate-of-turn indicator, slip-skid indicator, sensitive altimeter, clock, generator or alternator, gyroscopic attitude and direction indicators",
 ["Only a second altimeter and a clock", "Only an attitude indicator and a radio",
  "Only DME and an autopilot"],
 "91.205(d). The memory aid is GRABCARD. Note the sensitive altimeter must be adjustable for barometric pressure, and the clock must display hours, minutes and seconds."),
]
