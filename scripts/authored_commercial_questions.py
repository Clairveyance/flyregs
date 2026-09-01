"""Hand-authored Commercial-pilot question bank.

Same rules as the other boxes: written against text read from
far_sections.body_text, and the loader refuses any question whose supporting
text cannot be quoted.
"""

Q = [
("61.123", "Commercial Eligibility", "recall",
 "What is the minimum age for a commercial pilot certificate?",
 "18 years of age",
 ["17 years of age", "16 years of age", "21 years of age"],
 "61.123(a). Compare 61.103(a)'s 17 for private and 61.83(a)'s 16 for a student certificate. The three ages are a favourite oral-exam sequence."),

("61.129", "Commercial Experience", "recall",
 "What is the minimum total flight time for a commercial pilot certificate with an airplane single-engine rating under Part 61?",
 "250 hours",
 ["190 hours", "200 hours", "300 hours"],
 "61.129(a). The 190-hour figure is the Part 141 number and is the intended trap here -- 250 is the Part 61 requirement."),

("61.129", "Commercial Experience", "recall",
 "Of the 250 hours, how much pilot-in-command time is required?",
 "100 hours, including 50 hours in airplanes and 50 hours of cross-country of which at least 10 hours must be in airplanes",
 ["50 hours, all in airplanes", "100 hours, all of which must be cross-country",
  "150 hours, including 50 cross-country"],
 "61.129(a)(2). Note the nesting: the 50 hours of cross-country PIC sits INSIDE the 100 hours of PIC, and only 10 of that cross-country must be in airplanes."),

("61.129", "Commercial Experience", "recall",
 "What are the requirements of the long solo commercial cross-country?",
 "At least 300 nautical miles total distance, landings at a minimum of three points, one leg a straight-line distance of at least 250 nautical miles",
 ["300 nautical miles total with landings at two points",
  "250 nautical miles total with landings at three points",
  "150 nautical miles total with landings at three points"],
 "61.129(a)(4)(i). In Hawaii the longest segment need only be 150 nautical miles. This flight may be flown solo, or while performing PIC duties with an authorized instructor aboard."),

("61.129", "Commercial Experience", "recall",
 "What night experience is required within the 10 hours of solo/PIC-duties time?",
 "5 hours in night VFR conditions with 10 takeoffs and 10 landings at an airport with an operating control tower",
 ["3 hours at night with 10 takeoffs and landings at any airport",
  "5 hours at night with 5 takeoffs and landings at a towered airport",
  "10 hours at night with 10 takeoffs and landings"],
 "61.129(a)(4)(ii). Each landing must involve a flight in the traffic pattern, and the operating control tower is required -- a non-towered field does not satisfy it."),

("61.129", "Commercial Experience", "recall",
 "How much instrument training is required for the commercial certificate, and how much must be in a single-engine airplane?",
 "10 hours of instrument training, of which 5 hours must be in a single-engine airplane",
 ["10 hours, all of which must be in a single-engine airplane",
  "20 hours, of which 10 must be in a single-engine airplane",
  "5 hours, of which 3 must be in a single-engine airplane"],
 "61.129(a)(3)(i). This is training toward the commercial areas of operation and does NOT confer an instrument rating -- that is 61.65's separate 40 hours."),

("61.129", "Commercial Experience", "recall",
 "What aircraft must the 10 hours of training in 61.129(a)(3)(ii) be conducted in?",
 "A complex airplane, a turbine-powered airplane, or a technically advanced airplane (TAA), or any combination",
 ["A complex airplane only", "A high-performance airplane only",
  "Any airplane with retractable gear and a constant-speed propeller"],
 "61.129(a)(3)(ii). The TAA option was added so glass-cockpit trainers count; the airplane must be appropriate to the land or sea rating sought."),

("61.129", "Commercial Experience", "scenario",
 "A commercial applicant logs a 2-hour day cross-country covering 90 nautical miles straight-line. Does it satisfy 61.129(a)(3)(iii)?",
 "No -- the flight must cover a total straight-line distance of MORE than 100 nautical miles from the departure point",
 ["Yes, the 2-hour duration is what matters", "Yes, 90 nautical miles is sufficient",
  "Only if it included three landings"],
 "61.129(a)(3)(iii). Both conditions apply together: at least 2 hours AND more than 100 NM straight-line. A matching night flight is required by (a)(3)(iv)."),

("61.133", "Commercial Privileges", "recall",
 "What does a commercial pilot certificate allow?",
 "Acting as PIC carrying persons or property for compensation or hire, and flying for compensation or hire, provided the pilot is qualified under the applicable parts",
 ["Flying for any purpose without restriction",
  "Only flight instruction for compensation",
  "Only carrying property, never passengers, for hire"],
 "61.133(a)(1). The 'provided the person is qualified... with the applicable parts' clause is the important one -- most commercial carriage also requires an operating certificate under Part 119/135, which is why a commercial certificate alone does not let you start an air charter."),

("61.133", "Commercial Privileges", "scenario",
 "You hold a commercial certificate and want to fly paying passengers on demand in your own aircraft. Is the certificate alone enough?",
 "No -- commercial carriage generally also requires an air carrier or operating certificate under the applicable parts",
 ["Yes, a commercial certificate is all that is required",
  "Yes, provided you carry fewer than 6 passengers",
  "Yes, provided the flights stay within 50 nautical miles"],
 "61.133(a)(1) makes the privilege conditional on being qualified under 'the applicable parts of this chapter that apply to the operation.' Part 119.5 is what actually requires the operating certificate, and 119.1 defines who is caught by it."),

("61.125", "Commercial Knowledge", "recall",
 "Before taking the commercial knowledge test, what must the applicant obtain?",
 "A logbook endorsement from an authorized instructor who conducted or reviewed the required ground training and certified readiness for the test",
 ["Nothing -- the test may be taken at any time",
  "A written recommendation from a designated examiner",
  "A commercial ground school certificate from a Part 141 school"],
 "61.123(c). The endorsement must come from an instructor who conducted the ground training or reviewed the applicant's home study on the 61.125 knowledge areas for the category and class sought."),
]
