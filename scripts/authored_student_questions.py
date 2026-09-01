"""Hand-authored Student-pilot question bank.

Same rules as the other boxes: written against text read from
far_sections.body_text, never memory; the loader refuses any question whose
supporting text cannot be quoted.

Weighted toward the limitations a student actually has to keep straight before
and after first solo -- which is where the real-world consequences are.
"""

Q = [
# ── Student Eligibility ────────────────────────────────────────────────────
("61.83", "Student Eligibility", "recall",
 "What is the minimum age for a student pilot certificate for airplanes?",
 "16 years of age",
 ["14 years of age", "17 years of age", "18 years of age"],
 "61.83(a). Gliders and balloons drop to 14 under (b). Do not confuse this with 61.103(a)'s minimum age of 17 for the PRIVATE certificate -- you may solo at 16 but cannot be a private pilot until 17."),

("61.83", "Student Eligibility", "recall",
 "What is the minimum age to be a student pilot for GLIDER or BALLOON operations?",
 "14 years of age",
 ["16 years of age", "15 years of age", "12 years of age"],
 "61.83(b). The lower age reflects the lower-risk operation. All other categories require 16."),

("61.83", "Student Eligibility", "recall",
 "What language requirement applies to a student pilot certificate?",
 "Able to read, speak, write, and understand English, with limitations possible for a medical reason",
 ["English is not required for student certificates", "Only the ability to speak English",
  "English proficiency is required only for the private certificate"],
 "61.83(c). All four skills. The Administrator may place operating limitations on the certificate where a medical condition prevents meeting one of them."),

# ── Pre-Solo Requirements ──────────────────────────────────────────────────
("61.87", "Pre-Solo Requirements", "recall",
 "What three subject areas must the pre-solo knowledge test cover?",
 "Applicable sections of parts 61 and 91, airspace rules and procedures for the solo airport, and flight characteristics and operational limitations of the make and model flown",
 ["Only parts 61 and 91", "Only the aircraft's flight characteristics",
  "Weather theory, navigation, and aerodynamics"],
 "61.87(b)(1). All three. Note it is airspace for the SPECIFIC airport where the solo will happen, not airspace generally."),

("61.87", "Pre-Solo Requirements", "recall",
 "Who administers and grades the pre-solo knowledge test?",
 "The student's authorized instructor, who must also review all incorrect answers before authorizing solo",
 ["The FAA, at a testing center", "A designated pilot examiner",
  "The student, as a self-assessment"],
 "61.87(b)(2). The review of incorrect answers is a requirement, not a courtesy -- signing off a solo without it does not satisfy the rule."),

("61.87", "Pre-Solo Requirements", "recall",
 "How is 'solo flight' defined for a student pilot?",
 "Flight time during which the student is the sole occupant of the aircraft",
 ["Any flight without an instructor aboard", "Any flight where the student is the sole manipulator",
  "Any flight where the student is pilot in command"],
 "61.87(a). Sole OCCUPANT -- so carrying anyone at all, even another instructor as a passenger, means it is not solo flight. The definition also covers performing PIC duties in a gas balloon or airship requiring more than one crewmember."),

("61.87", "Pre-Solo Requirements", "recall",
 "How current must the make-and-model solo endorsement be?",
 "Given by an authorized instructor within the 90 days preceding the flight",
 ["Within the 60 days preceding the flight", "Within the 6 calendar months preceding the flight",
  "It does not expire once given"],
 "61.87(n). The endorsement is aircraft-specific AND time-limited -- a student current in a 172 is not endorsed for a 152, and the 90 days runs from the date the instructor gave the training."),

("61.87", "Pre-Solo Requirements", "scenario",
 "A student was endorsed for solo in a Cessna 172 on 1 March. On 20 June they want to solo the same aircraft. Is the endorsement valid?",
 "No -- more than 90 days have passed, so a new endorsement is required",
 ["Yes, solo endorsements are valid for 6 months", "Yes, endorsements do not expire for the same aircraft",
  "Yes, provided the student has flown with an instructor since"],
 "61.87(n). 1 March to 20 June is about 111 days. The rule counts 90 days preceding the FLIGHT, so the endorsement lapsed around 30 May regardless of intervening dual instruction."),

# ── Student Limitations ────────────────────────────────────────────────────
("61.89", "Student Limitations", "recall",
 "May a student pilot carry a passenger?",
 "No, under no circumstances",
 ["Yes, with an instructor endorsement", "Yes, after 20 hours of solo time",
  "Yes, if the passenger is another student pilot"],
 "61.89(a)(1). Absolute. It sits alongside prohibitions on carrying property for compensation, flying for compensation, and flying in furtherance of a business."),

("61.89", "Student Limitations", "recall",
 "What are the minimum visibility limits for student pilot solo flight?",
 "3 statute miles during the day and 5 statute miles at night",
 ["1 statute mile day, 3 statute miles night", "3 statute miles day and night",
  "5 statute miles day, 5 statute miles night"],
 "61.89(a)(6). These are STRICTER than the Class G VFR minimums a certificated pilot may use (1 SM by day), and they apply to the student regardless of airspace."),

("61.89", "Student Limitations", "recall",
 "May a student pilot fly solo above a solid overcast layer?",
 "No -- a student may not fly when the flight cannot be made with visual reference to the surface",
 ["Yes, if VFR on top and the destination is clear", "Yes, with an instructor endorsement",
  "Yes, if the student holds an instrument rating"],
 "61.89(a)(7). Visual reference to the surface must be maintained throughout, which rules out VFR-on-top operations for a student even where a certificated private pilot could legally do it."),

("61.89", "Student Limitations", "recall",
 "May a student pilot fly an international flight?",
 "No, except for specified solo training flights between certain Alaskan airports and White Horse, Yukon",
 ["Yes, with an instructor endorsement", "Yes, to Canada and Mexico only",
  "Yes, with no restriction"],
 "61.89(a)(5). The Alaska/Yukon carve-out is narrow and specific -- Haines, Gustavus or Juneau to White Horse and return over British Columbia."),

("61.89", "Student Limitations", "scenario",
 "A student's instructor wrote a logbook limitation of 'no solo with crosswind above 8 knots.' The student solos in a 12-knot crosswind. What rule is broken?",
 "61.89(a)(8) -- a student may not fly contrary to any limitation placed in their logbook by an authorized instructor",
 ["No rule, logbook limitations are advisory", "Only the instructor is responsible, not the student",
  "61.87, because the endorsement expired"],
 "61.89(a)(8) makes instructor-written limitations regulatory, not advisory. Exceeding one is a violation by the student even though the limit came from the instructor rather than the FARs."),

("61.89", "Student Limitations", "recall",
 "May a student pilot act as a required crewmember on an aircraft requiring more than one pilot?",
 "No, except when receiving training aboard an airship with no one else but required crew on board",
 ["Yes, if under instructor supervision", "Yes, once solo-endorsed",
  "Yes, on any aircraft they are rated for"],
 "61.89(b). The airship exception is the only one, and even then no person other than a required flight crewmember may be carried."),

# ── Solo Cross-Country ─────────────────────────────────────────────────────
("61.93", "Solo Cross-Country", "recall",
 "What distance from the departure airport triggers the solo cross-country requirements?",
 "More than 25 nautical miles from the airport where the flight originated",
 ["More than 50 nautical miles", "More than 15 nautical miles", "More than 100 nautical miles"],
 "61.93(a)(1)(i). The requirements also trigger on ANY solo landing at a location other than the airport of origination, however short the distance -- so a 10 NM hop to another field still needs the cross-country endorsement."),

("61.93", "Solo Cross-Country", "scenario",
 "A student wants to solo to an airport 12 nautical miles away and land there. Is a solo cross-country endorsement required?",
 "Yes -- landing at any airport other than the airport of origination triggers 61.93, regardless of distance",
 ["No, because it is under 25 nautical miles", "No, because it is under 50 nautical miles",
  "Only if the destination has a control tower"],
 "61.93(a)(1)(ii) is a separate trigger from the 25 NM one in (a)(1)(i). Reading only the distance rule is the classic error -- the landing-elsewhere trigger has no distance floor."),

("61.93", "Solo Cross-Country", "recall",
 "What must a student have accomplished in the make and model before receiving solo cross-country privileges?",
 "The pre-solo flight maneuvers and procedures required by 61.87, in that or a similar make and model",
 ["A minimum of 20 hours of solo time", "The private pilot knowledge test",
  "A flight review with a second instructor"],
 "61.93(a)(2)(iii). Solo cross-country privileges build on 61.87 rather than replacing it, and the student must also demonstrate cross-country proficiency and comply with any limitations in the instructor's endorsement."),
]
