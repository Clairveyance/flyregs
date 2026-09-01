"""Hand-authored Private-pilot question bank, batch 1.

Authored 2026-09-01 against the ACTUAL body_text of each section (read before
writing -- accuracy outranks volume here; a wrong reg answer is worse than no
question). Every row attaches to a real far_sections.section_number, so it
inherits that section's knowledge-level box automatically.

Shape mirrors what made RC's Ready Room file work and what the generated bank
lacks: a study CATEGORY, a recall/scenario TYPE, and an EXPLANATION that says
why the answer matters and which sibling reg it gets confused with -- not just
a quote of the rule.

Distractors encode real, specific confusions (the three definitions of night;
30 vs 45 minutes of fuel; 1,000 ft above vs 500 ft below), never filler.
"""

# (item_id, category, q_type, question, answer, [3 distractors], explanation)
Q = [

# ── Pilot Certification & Privileges ────────────────────────────────────────
("61.113", "Pilot Certification & Privileges", "recall",
 "As a private pilot, what is the most you may accept from passengers on a flight?",
 "The pro rata share of fuel, oil, airport expenditures, and rental fees",
 ["The full cost of the flight", "Nothing at all, ever", "Anything the passengers offer voluntarily"],
 "61.113(c) says a private pilot may not pay LESS than the pro rata share -- meaning you must pay at least your own equal portion. The expense list is closed: fuel, oil, airport expenditures, rental fees. Paying for a hotel or a meal is not on that list."),

("61.113", "Pilot Certification & Privileges", "scenario",
 "You and three passengers fly to lunch. Total cost is $200. What is the least you may pay?",
 "$50 -- your equal (pro rata) share of the four occupants",
 ["$0, the passengers may cover it all", "$100, you must pay at least half", "$200, you must pay the whole cost"],
 "Pro rata means dividing by everyone on board including you: $200 / 4 = $50. A common trap is thinking the pilot may fly free if passengers volunteer -- 61.113(c) forbids paying less than your share."),

("61.113", "Pilot Certification & Privileges", "scenario",
 "Your employer asks you to fly yourself to a meeting in the company airplane. Is this allowed as a private pilot?",
 "Yes, if the flight is only incidental to the business and carries no passengers or property for hire",
 ["No, a private pilot may never fly for business", "Yes, and you may also carry paying clients", "Only if you hold a commercial certificate"],
 "61.113(b) is the 'incidental to business' exception. The flight may serve your job, but the moment the airplane itself is carrying passengers or property FOR hire, it stops being incidental and needs a commercial certificate."),

("61.113", "Pilot Certification & Privileges", "recall",
 "A private pilot who is an aircraft salesman may demonstrate an aircraft to a buyer after logging how much flight time?",
 "200 hours",
 ["100 hours", "250 hours", "500 hours"],
 "61.113(f). One of the few numeric privileges hidden in this section, and a favorite oral-exam question precisely because it is easy to overlook."),

("61.3", "Pilot Certification & Privileges", "recall",
 "What must a private pilot have in personal possession or readily accessible in the aircraft when acting as PIC?",
 "Pilot certificate, medical certificate (or BasicMed documents), and photo ID",
 ["Pilot certificate only", "Pilot certificate and logbook", "Pilot certificate and aircraft registration"],
 "61.3 requires all three. Note the logbook is NOT among them for a certificated pilot -- students and pilots exercising certain privileges must carry endorsements, but a private pilot need not carry a logbook on every flight."),

("61.103", "Pilot Certification & Privileges", "recall",
 "What is the minimum age to be eligible for a private pilot certificate for airplanes?",
 "17 years old",
 ["16 years old", "18 years old", "21 years old"],
 "61.103(a). Contrast with 61.83, where 16 is the minimum age to SOLO an airplane -- the two ages are different and are routinely swapped on knowledge tests."),

("61.105", "Pilot Certification & Privileges", "recall",
 "Before taking the private pilot knowledge test, what must the applicant have received regarding aeronautical knowledge?",
 "Ground training or a home-study course covering the required knowledge areas, logged by an authorized instructor",
 ["Nothing -- the test may be taken at any time", "A college ground-school degree", "50 hours of flight time first"],
 "61.105 lists the aeronautical knowledge areas and requires the training be received and logged. This works together with 61.35 (the test rules) and 61.103 (overall eligibility) -- three separate sections that together govern the knowledge test."),

("61.109", "Pilot Certification & Privileges", "recall",
 "What is the minimum total flight time for a private pilot certificate with an airplane single-engine rating under Part 61?",
 "40 hours",
 ["35 hours", "20 hours", "60 hours"],
 "61.109(a): 40 hours total, including at least 20 hours of training from an instructor and 10 hours of solo. Note a Part 141 school may certificate in fewer hours -- the 40 is the Part 61 figure."),

("61.109", "Pilot Certification & Privileges", "recall",
 "Within the 3 hours of night flight training required for a private pilot certificate, what specific night cross-country is required?",
 "One cross-country flight of over 100 nautical miles total distance",
 ["One cross-country of over 50 nautical miles", "One cross-country of over 150 nautical miles", "No cross-country is required at night"],
 "61.109(a)(2)(i). The same paragraph also requires 10 night takeoffs and 10 landings to a full stop, each involving a traffic-pattern flight. The 100 NM night figure and the 50 NM solo figure are frequently confused."),

("61.60", "Pilot Certification & Privileges", "recall",
 "After a permanent change of mailing address, how long may you exercise certificate privileges before notifying the FAA?",
 "30 days",
 ["60 days", "90 days", "There is no time limit"],
 "61.60. After 30 days without written notification you may not exercise the privileges of the certificate at all. Note this is 30 days -- distinct from 61.15's 60-day window for reporting a motor vehicle drug/alcohol action."),

# ── Medical & BasicMed ──────────────────────────────────────────────────────
("61.23", "Medical & BasicMed", "recall",
 "What class of medical certificate is required to exercise private pilot privileges?",
 "At least a third-class medical certificate (or BasicMed, if eligible)",
 ["First class", "Second class", "No medical is ever required"],
 "61.23(a)(3)(i). Third class is the floor for private, recreational and student privileges. Second class attaches to commercial privileges and first class to ATP privileges."),

("61.23", "Medical & BasicMed", "scenario",
 "A pilot exercising private pilot privileges holds a valid U.S. driver's license and meets BasicMed requirements. Must they also hold a medical certificate?",
 "No -- 61.113(i) allows private pilot privileges under BasicMed without a part 67 medical",
 ["Yes, a third-class medical is always required", "Yes, unless flying solo", "Only for flights over 50 NM"],
 "61.23(a)(3)(i) carves out 'except when operating under the conditions and limitations set forth in 61.113(i)' -- the BasicMed path. BasicMed is not a medical certificate; it is an alternative to holding one."),

("61.23", "Medical & BasicMed", "recall",
 "Under BasicMed, within what period must the medical education course have been completed?",
 "The 24 calendar months before acting as PIC",
 ["The 48 calendar months before acting as PIC", "The 12 calendar months before acting as PIC",
  "Once ever, with no recurring requirement"],
 "61.23(c)(3)(i)(C). Pair it with the other BasicMed clock in the very next subparagraph: (D) requires a comprehensive medical examination by a State-licensed physician within the preceding 48 calendar months. Two intervals -- 24 for the course, 48 for the exam -- and swapping them is the classic error. Note both live in 61.23, not in Part 68; 68.3 only prescribes what the COURSE must cover."),

("68.3", "Medical & BasicMed", "recall",
 "What does 14 CFR 68.3 actually prescribe?",
 "The required content of the BasicMed medical education course",
 ["How often the course must be retaken", "The aircraft limits that apply under BasicMed",
  "The physician examination interval"],
 "68.3 lists what the course must teach -- self-assessment, warning signs, risk mitigation, medication effects -- and requires it deliver the FAA checklist from 68.7. The recurring INTERVALS are in 61.23(c)(3), and the aircraft/operating limits are in 61.113(i). Three different sections, routinely conflated."),

("61.113", "Medical & BasicMed", "recall",
 "Under BasicMed, what are the aircraft limits?",
 "Authorized to carry not more than 7 occupants, maximum takeoff weight not more than 12,500 pounds, and no more than 6 passengers aboard",
 ["Not more than 6 occupants and 6,000 pounds maximum takeoff weight",
  "Not more than 4 occupants and 4,000 pounds maximum takeoff weight",
  "Any aircraft, provided it is not turbine powered"],
 "61.113(i)(1), as it reads TODAY. Many study guides still quote the original 2017 BasicMed figures (6 seats / 6,000 lbs / 5 passengers) -- those are outdated. The rule also excludes transport-category rotorcraft certificated under part 29."),

("61.113", "Medical & BasicMed", "recall",
 "Under BasicMed, what altitude and speed limits apply?",
 "Not above 18,000 feet MSL and not exceeding 250 knots indicated airspeed",
 ["Not above 10,000 feet MSL and not exceeding 200 knots",
  "Not above 12,500 feet MSL and not exceeding 250 knots",
  "No altitude or speed limits apply"],
 "61.113(i)(2). The same paragraph also bars flight outside the United States unless the country in which the flight is conducted authorizes it."),

("61.15", "Alcohol, Drugs & Fitness", "recall",
 "Within how many days must you report a motor vehicle action involving alcohol or drugs to the FAA?",
 "60 days",
 ["30 days", "90 days", "Only at your next medical exam"],
 "61.15(e). It is reported to the FAA Civil Aviation Registry, and it counts even though the offense happened in a car on the ground. Do not confuse the 60 days here with 61.60's 30 days for an address change."),

("91.17", "Alcohol, Drugs & Fitness", "recall",
 "How long must you wait after consuming alcohol before acting as a crewmember?",
 "8 hours",
 ["12 hours", "24 hours", "4 hours"],
 "91.17(a)(1). The rule has three independent prongs: 8 hours bottle-to-throttle, a blood alcohol concentration under 0.04, and not being under the influence at all. Satisfying the 8 hours does not excuse the other two."),

("91.17", "Alcohol, Drugs & Fitness", "recall",
 "What blood alcohol concentration disqualifies a person from acting as a crewmember, regardless of time elapsed?",
 "An alcohol concentration of 0.04 or greater in a blood or breath specimen",
 ["0.08 or greater", "0.02 or greater", "Any measurable amount"],
 "91.17(a)(4). Note 0.04 is stricter than the typical 0.08 driving limit, and the 8-hour rule is separate -- you can be past 8 hours and still be illegal if your BAC is 0.04 or higher."),

# ── Currency & Flight Review ────────────────────────────────────────────────
("61.56", "Currency & Flight Review", "recall",
 "What are the minimum training requirements of a flight review?",
 "1 hour of flight training and 1 hour of ground training",
 ["2 hours of flight training only", "1 hour of ground training only", "3 hours total, split at the instructor's discretion"],
 "61.56(a). The ground portion must review the current general operating and flight rules of Part 91; the flight portion covers maneuvers the instructor deems necessary. Both hours are required -- a flight-only review does not satisfy the rule."),

("61.56", "Currency & Flight Review", "recall",
 "How current must a flight review be to act as pilot in command?",
 "Within the preceding 24 calendar months",
 ["Within the preceding 12 calendar months", "Within the preceding 6 calendar months", "Within the preceding 36 calendar months"],
 "61.56(c). Note 'calendar months' -- a review completed on 14 March 2026 is good through 31 March 2028, not 14 March 2028. This is a flight-review clock only; it does not make you current to carry passengers (see 61.57)."),

("61.56", "Currency & Flight Review", "scenario",
 "You passed a practical test for an instrument rating 8 months ago. Do you also need a flight review?",
 "No -- passing a practical test for a rating satisfies the flight review requirement",
 ["Yes, a flight review is always separately required", "Only if the checkride was in a different category", "Yes, unless the examiner endorsed your logbook for it"],
 "61.56(d)(1). Any pilot proficiency check or practical test for a certificate, rating, or operating privilege resets the 24-month clock. Many pilots pay for a review they do not need after a checkride."),

("61.57", "Currency & Flight Review", "recall",
 "To carry passengers, what recent experience is required in the preceding 90 days?",
 "Three takeoffs and three landings as sole manipulator of the controls",
 ["One takeoff and one landing", "Three takeoffs and three landings within 60 days", "A flight review within 90 days"],
 "61.57(a)(1). They must be in the same category, class, and type (if a type rating is required). Note this is passenger-carrying currency only -- you may legally fly solo without it."),

("61.57", "Currency & Flight Review", "recall",
 "What additional requirement applies to the three landings for NIGHT passenger currency?",
 "They must be to a full stop, between 1 hour after sunset and 1 hour before sunrise",
 ["They must be touch-and-go landings", "They must be at a towered airport", "They must be made between sunset and sunrise"],
 "61.57(b). This is the second of three different definitions of night in the FARs: 1.1 uses civil twilight, 61.57(b) uses 1 hour after sunset to 1 hour before sunrise, and 91.209 uses sunset to sunrise for position lights."),

("61.57", "Currency & Flight Review", "scenario",
 "It is 25 minutes after sunset. You make three full-stop landings with a passenger aboard. Do these count toward night currency under 61.57(b)?",
 "No -- 61.57(b) requires the landings between 1 hour after sunset and 1 hour before sunrise",
 ["Yes, any time after sunset counts", "Yes, because it is after civil twilight", "Only if the landing light was operating"],
 "This is the three-definitions-of-night trap. Twenty-five minutes after sunset may already be 'night' for logging under 1.1 and requires position lights under 91.209, yet it is still outside 61.57(b)'s narrower window."),

("61.57", "Currency & Flight Review", "recall",
 "A tailwheel airplane adds what extra condition to the three takeoffs and landings for passenger currency?",
 "The landings must be made to a full stop",
 ["They must be made at night", "They must be made with an instructor aboard", "They must be made within 30 days"],
 "61.57(a)(1)(ii). Tailwheel airplanes require full-stop landings for day passenger currency, because the landing rollout is where directional control is most demanding."),

("61.51", "Logbooks & Records", "recall",
 "Which flight time must a private pilot log?",
 "Time used to meet certificate, rating, or recent flight experience requirements",
 ["All flight time, without exception", "Only cross-country time", "Only flight time in the last 12 months"],
 "61.51(a). Beyond training and currency, logging is optional -- many pilots log everything by habit, but the regulation only compels the time that proves a requirement."),

("61.51", "Logbooks & Records", "scenario",
 "You are the sole manipulator of the controls in an airplane you are rated for, with an instructor aboard. May you log PIC time?",
 "Yes -- a rated pilot may log PIC whenever they are the sole manipulator of the controls",
 ["No, only the instructor may log PIC", "Only if the instructor is not being paid", "Only if you are also the acting PIC"],
 "61.51(e)(1)(i). Logging PIC and ACTING as PIC are different things -- both you and the instructor may log PIC for the same flight, while only one of you is legally responsible for it under 91.3."),

("61.87", "Pilot Certification & Privileges", "recall",
 "Before a student pilot may solo, what must they have demonstrated to an authorized instructor?",
 "Satisfactory aeronautical knowledge on a pre-solo written test and proficiency in the required maneuvers",
 ["Only 20 hours of flight time", "A passing grade on the FAA knowledge test", "A third-class medical and nothing more"],
 "61.87(b) requires the instructor-administered pre-solo knowledge test covering Parts 61 and 91 plus the flight characteristics of the aircraft. It is given and graded by the instructor, not the FAA."),

("61.89", "Pilot Certification & Privileges", "recall",
 "May a student pilot carry passengers?",
 "No -- a student pilot may not carry passengers under any circumstances",
 ["Yes, with an instructor endorsement", "Yes, but only family members", "Yes, after 40 hours of flight time"],
 "61.89(a)(1). The prohibition is absolute, alongside bans on carrying property for compensation, flying for compensation, and flying in furtherance of a business."),
]

Q += [
# ── VFR Weather Minimums ────────────────────────────────────────────────────
("91.155", "VFR Weather Minimums", "recall",
 "In Class B airspace, what are the VFR visibility and cloud clearance requirements?",
 "3 statute miles visibility and clear of clouds",
 ["3 statute miles and 500 below / 1,000 above / 2,000 horizontal",
  "1 statute mile and clear of clouds", "5 statute miles and 1,000 below / 1,000 above / 1 mile horizontal"],
 "91.155(a). Class B is the only controlled airspace with a 'clear of clouds' standard -- everywhere else in Class C, D, and E below 10,000 requires the 500/1,000/2,000 split. The logic is that ATC separates all traffic in Class B."),

("91.155", "VFR Weather Minimums", "recall",
 "At or above 10,000 feet MSL in Class E airspace, what are the VFR minimums?",
 "5 statute miles, 1,000 feet below, 1,000 feet above, 1 statute mile horizontal",
 ["3 statute miles, 500 below, 1,000 above, 2,000 horizontal",
  "5 statute miles, 500 below, 1,000 above, 2,000 horizontal",
  "3 statute miles and clear of clouds"],
 "91.155(a). The jump at 10,000 MSL exists because aircraft may exceed 250 knots above that altitude (91.117), so closure rates demand more room to see and avoid."),

("91.155", "VFR Weather Minimums", "recall",
 "In Class G airspace at 1,200 feet or less AGL during the DAY, what are the minimums for an airplane?",
 "1 statute mile visibility and clear of clouds",
 ["3 statute miles and clear of clouds", "1 statute mile with 500 below / 1,000 above / 2,000 horizontal",
  "1/2 statute mile and clear of clouds"],
 "91.155(a). At night the same airspace requires 3 statute miles and the 500/1,000/2,000 split. The 1/2 statute mile figure belongs to helicopters by day, not airplanes."),

("91.155", "VFR Weather Minimums", "scenario",
 "You are in Class G at 1,000 AGL at night in an airplane with 2 miles visibility. Is VFR flight legal?",
 "No -- Class G at night requires 3 statute miles for an airplane",
 ["Yes, 1 mile is the Class G minimum", "Yes, if you remain clear of clouds", "Yes, if you stay within 5 miles of an airport"],
 "The day figure (1 SM, clear of clouds) is the one pilots remember; the night figure jumps to 3 SM with 500/1,000/2,000 cloud clearance. Losing track of which applies is a common night cross-country trap."),

("91.157", "VFR Weather Minimums", "recall",
 "What are the basic requirements for Special VFR in a control zone during the day?",
 "1 statute mile flight visibility, clear of clouds, and an ATC clearance",
 ["3 statute miles and clear of clouds", "1 statute mile and 500 feet below clouds",
  "No visibility requirement if cleared by ATC"],
 "91.157. Special VFR must be requested and cleared -- ATC will not offer it. At night it additionally requires the pilot to be instrument rated and the aircraft instrument equipped."),

# ── Altitudes & Speed Limits ────────────────────────────────────────────────
("91.159", "Altitudes & Speed Limits", "recall",
 "Flying VFR on a magnetic course of 090 degrees above 3,000 feet AGL, what cruising altitude is appropriate?",
 "Odd thousand plus 500 feet (such as 5,500 or 7,500)",
 ["Even thousand plus 500 feet (such as 6,500)", "Any odd thousand (such as 5,000)",
  "Any altitude, VFR cruising rules are advisory"],
 "91.159(a)(1). East is odd: courses 0-179 degrees take odd thousands +500. The rule applies only in level cruising flight MORE than 3,000 feet above the SURFACE -- not above MSL, a distinction often missed."),

("91.159", "Altitudes & Speed Limits", "scenario",
 "You are cruising VFR at 2,500 feet AGL on a magnetic course of 270 degrees. Must you fly an even thousand plus 500?",
 "No -- the hemispheric rule only applies more than 3,000 feet above the surface",
 ["Yes, it applies at all altitudes", "Yes, because you are westbound", "Only if you are in controlled airspace"],
 "91.159 begins 'more than 3,000 feet above the surface.' Below that, any altitude is legal as far as this rule is concerned, though 91.119's minimum safe altitudes still apply."),

("91.117", "Altitudes & Speed Limits", "recall",
 "What is the maximum indicated airspeed below 10,000 feet MSL?",
 "250 knots",
 ["200 knots", "288 knots", "230 knots"],
 "91.117(a). The 288 figure is the same speed expressed in mph, included in the reg's own text -- a classic distractor. Below 2,500 AGL within 4 NM of a Class C or D primary airport, the limit tightens to 200 knots."),

("91.117", "Altitudes & Speed Limits", "recall",
 "What is the maximum indicated airspeed in the airspace underlying a Class B area, or in a VFR corridor through it?",
 "200 knots",
 ["250 knots", "230 knots", "180 knots"],
 "91.117(c). Note the contrast: INSIDE Class B the limit is the general 250 knots below 10,000, but UNDERNEATH the shelf it drops to 200 -- because that is where VFR traffic is compressed."),

("91.119", "Altitudes & Speed Limits", "recall",
 "Over a congested area, what is the minimum safe altitude?",
 "1,000 feet above the highest obstacle within a horizontal radius of 2,000 feet",
 ["500 feet above the highest obstacle within 1,000 feet", "1,000 feet AGL anywhere",
  "2,000 feet above the highest obstacle within 1,000 feet"],
 "91.119(b). Both numbers matter and are easy to swap: 1,000 feet vertically, 2,000 feet horizontally. Over non-congested areas it becomes 500 feet AGL."),

("91.119", "Altitudes & Speed Limits", "recall",
 "Over open water or sparsely populated areas, what is the minimum distance from any person, vessel, vehicle, or structure?",
 "500 feet",
 ["1,000 feet", "2,000 feet", "There is no minimum over open water"],
 "91.119(c). Over sparsely populated areas there is no 500-foot AGL floor -- instead you must simply stay 500 feet away from any person, vessel, vehicle or structure, which permits legal low flight over empty terrain."),

("91.121", "Altitudes & Speed Limits", "recall",
 "Below 18,000 feet MSL, what altimeter setting must you use?",
 "The current reported setting of a station along the route within 100 nautical miles",
 ["29.92 inches Hg", "The setting at your departure airport for the whole flight",
  "The setting of the nearest station regardless of distance"],
 "91.121(a)(1)(i). The 100 NM radius is the tested detail. At and above 18,000 MSL everyone sets 29.92, which is what makes them flight levels rather than altitudes."),

# ── Right-of-Way & Operating Rules ──────────────────────────────────────────
("91.113", "Right-of-Way & Operating Rules", "recall",
 "Which aircraft has the right-of-way over all other air traffic?",
 "An aircraft in distress",
 ["A balloon", "A glider", "An aircraft towing another aircraft"],
 "91.113(c). Distress outranks everything. The category order that follows is balloon, glider, airship, then towing/refueling aircraft, then everything else -- roughly ordered by how little ability each has to maneuver."),

("91.113", "Right-of-Way & Operating Rules", "scenario",
 "Two airplanes of the same category are converging at the same altitude, not head-on. Who has the right-of-way?",
 "The aircraft to the other's right",
 ["The faster aircraft", "The aircraft at the lower altitude", "The aircraft to the other's left"],
 "91.113(d). Same category converging: the one on the RIGHT has the right-of-way -- if you see traffic off your right side, you give way. Different categories fall back to the balloon/glider/airship ordering instead."),

("91.113", "Right-of-Way & Operating Rules", "recall",
 "A glider and a powered airplane are converging. Which has the right-of-way?",
 "The glider",
 ["The airplane", "Whichever is to the right", "Whichever is lower"],
 "91.113(d)(2). A glider cannot add power to escape, so it outranks powered aircraft. Only a balloon and an aircraft in distress outrank a glider."),

("91.111", "Right-of-Way & Operating Rules", "recall",
 "When may an aircraft be operated in formation flight?",
 "Only by arrangement with the pilot in command of each aircraft in the formation",
 ["Any time, if the pilots can see each other", "Only with an ATC clearance",
  "Only in Class G airspace"],
 "91.111(b). Formation flight also may never be flown with passengers for hire (91.111(c)), and 91.111(a) forbids operating so close to another aircraft as to create a collision hazard."),

("91.123", "Right-of-Way & Operating Rules", "scenario",
 "ATC gives you a clearance you cannot safely comply with. What must you do?",
 "Request an amended clearance -- you may not deviate except in an emergency",
 ["Comply anyway, ATC has final authority", "Deviate silently and continue",
  "Squawk 7700 and land immediately"],
 "91.123(a). If an emergency does require deviating, 91.123(b) requires you notify ATC as soon as possible, and 91.123(c) lets ATC request a written report within 48 hours. 91.3(b) is the underlying emergency authority."),

("91.3", "Right-of-Way & Operating Rules", "recall",
 "Who is directly responsible for, and the final authority as to, the operation of an aircraft?",
 "The pilot in command",
 ["The aircraft owner", "The air traffic controller", "The flight instructor, if one is aboard"],
 "91.3(a). This is the foundational rule of Part 91. Paragraph (b) lets the PIC deviate from any rule of Part 91 to the extent required to meet an in-flight emergency."),

("91.103", "Right-of-Way & Operating Rules", "recall",
 "What preflight information is specifically required for a flight not in the vicinity of an airport?",
 "Weather reports and forecasts, fuel requirements, alternatives if the flight cannot be completed, and any known traffic delays",
 ["Only the destination weather", "Only a completed navigation log",
  "Only the aircraft's weight and balance"],
 "91.103(a). For IFR flights or any flight not in the vicinity of an airport, runway lengths and takeoff/landing distance data are also required under 91.103(b) -- the part pilots most often skip."),

("91.15", "Right-of-Way & Operating Rules", "recall",
 "May objects be dropped from an aircraft in flight?",
 "Yes, if reasonable precautions are taken to avoid injury or damage to persons and property",
 ["No, never under any circumstances", "Only over open water", "Only with an ATC clearance"],
 "91.15. Dropping is permitted with precautions -- the rule targets hazard, not the act itself. This is what makes banner and jump operations lawful."),

# ── Airspace ────────────────────────────────────────────────────────────────
("91.131", "Airspace", "recall",
 "What is required before operating in Class B airspace?",
 "An ATC clearance from the facility having jurisdiction over that area",
 ["Two-way radio communication established", "A transponder only",
  "Nothing, if you remain clear of clouds"],
 "91.131(a)(1). The word is CLEARANCE -- an explicit 'cleared into the Class B.' This differs sharply from Class C and D, where merely establishing two-way radio communication is enough."),

("91.130", "Airspace", "recall",
 "What is required to enter Class C airspace?",
 "Two-way radio communication established with the ATC facility providing services",
 ["An explicit ATC clearance", "A private pilot certificate", "Nothing, if squawking 1200"],
 "91.130(c). If the controller says your N-number back without 'remain clear', two-way communication is established and you may enter. A clearance is required only for Class B."),

("91.129", "Airspace", "recall",
 "What is required to operate in Class D airspace?",
 "Two-way radio communication established with the control tower",
 ["An ATC clearance", "A transponder with Mode C", "An instrument rating"],
 "91.129(c). Class D requires communication only -- no transponder is required by this section, which is why many Class D airports serve aircraft without electrical systems."),

("91.126", "Airspace", "recall",
 "Approaching to land at a non-towered airport in Class G, which direction must turns be made?",
 "All turns to the left, unless light signals or visual markings indicate right turns",
 ["All turns to the right", "Whichever direction the wind favors",
  "Pilot's discretion at all non-towered fields"],
 "91.126(b)(1). Left traffic is the default; a right pattern must be published or indicated by a segmented circle. This applies to powered fixed-wing aircraft."),

("91.215", "Airspace", "recall",
 "In which airspace is a transponder with Mode C generally required?",
 "Class A, Class B, Class C, and above the ceiling of Class B or C up to 10,000 feet MSL",
 ["Class D only", "Class G above 1,200 feet AGL", "All controlled airspace without exception"],
 "91.215(b). It is also required within 30 NM of a Class B primary airport (the Mode C veil) and generally at and above 10,000 MSL, excluding airspace at and below 2,500 AGL."),
]

Q += [
# ── Fuel Requirements ───────────────────────────────────────────────────────
("91.151", "Fuel Requirements", "recall",
 "Under VFR during the DAY, how much fuel reserve is required beyond the first point of intended landing?",
 "Enough to fly 30 minutes at normal cruising speed",
 ["20 minutes", "45 minutes", "60 minutes"],
 "91.151(a)(1). At night it becomes 45 minutes; for rotorcraft it is 20 minutes day or night. Three different numbers in one short section, which is exactly why it is tested."),

("91.151", "Fuel Requirements", "scenario",
 "You plan a night VFR flight arriving with 35 minutes of fuel remaining. Is this legal?",
 "No -- night VFR requires a 45-minute reserve",
 ["Yes, 30 minutes is the requirement", "Yes, reserves are only advisory",
  "Only if the destination has no alternate"],
 "91.151(a)(2). The reserve is computed at normal cruising speed and must consider wind and forecast weather -- so it is planned fuel, not merely what happens to be in the tanks on arrival."),

("91.151", "Fuel Requirements", "recall",
 "What VFR fuel reserve applies to a rotorcraft?",
 "20 minutes, day or night",
 ["30 minutes day, 45 minutes night", "45 minutes at all times", "30 minutes at all times"],
 "91.151(b). Rotorcraft get a single 20-minute figure that does not change with day or night, unlike the airplane rule directly above it."),

# ── Oxygen & Altitude ───────────────────────────────────────────────────────
("91.211", "Oxygen & Altitude", "recall",
 "Above what cabin pressure altitude must the required minimum flight crew use oxygen after 30 minutes?",
 "12,500 feet MSL, up to and including 14,000 feet MSL",
 ["10,000 feet MSL", "14,000 feet MSL", "15,000 feet MSL"],
 "91.211(a)(1). The 30-minute allowance applies only in the 12,500 to 14,000 band. Above 14,000 the crew must use oxygen for the ENTIRE time at those altitudes, with no grace period."),

("91.211", "Oxygen & Altitude", "recall",
 "Above what cabin pressure altitude must each occupant be PROVIDED with supplemental oxygen?",
 "15,000 feet MSL",
 ["12,500 feet MSL", "14,000 feet MSL", "18,000 feet MSL"],
 "91.211(a)(3). Note the verb: occupants must be PROVIDED oxygen above 15,000, but are not required to use it. Only the required minimum flight crew must actually USE it, above 14,000."),

("91.211", "Oxygen & Altitude", "scenario",
 "You cruise at 13,500 feet MSL for 45 minutes. What does 91.211 require?",
 "The required minimum flight crew must use supplemental oxygen for the portion beyond 30 minutes",
 ["Nothing, 13,500 is below the oxygen threshold",
  "All occupants must be provided oxygen", "All occupants must use oxygen"],
 "13,500 sits in the 12,500-14,000 band, so the 30-minute clock applies and only the required flight crew is affected. Passengers are not entitled to oxygen until 15,000."),

# ── Required Documents & Equipment ──────────────────────────────────────────
("91.203", "Required Documents & Equipment", "recall",
 "Which documents must be aboard the aircraft for flight?",
 "Airworthiness certificate and registration certificate",
 ["Airworthiness certificate only", "Registration and the pilot's logbook",
  "Airworthiness certificate and maintenance records"],
 "91.203(a). Combined with 91.9's flight manual and placards, this is the basis of the ARROW memory aid. Maintenance records specifically do NOT need to be carried aboard."),

("91.9", "Required Documents & Equipment", "recall",
 "What does 91.9 require to be aboard a U.S.-registered civil aircraft?",
 "The current approved flight manual, markings, and placards",
 ["The aircraft's maintenance logbooks", "The pilot's medical certificate",
  "A copy of Part 91"],
 "91.9. Together with 91.203's airworthiness and registration certificates, these form the documents a ramp check will ask for."),

("91.205", "Required Documents & Equipment", "recall",
 "Which of these is required equipment for DAY VFR flight?",
 "Fuel gauge indicating the quantity of fuel in each tank",
 ["Attitude indicator", "Position lights", "Gyroscopic heading indicator"],
 "91.205(b). Attitude and heading indicators belong to the IFR list; position lights are on the night list. A fuel quantity gauge for EACH tank is required even in day VFR."),

("91.205", "Required Documents & Equipment", "recall",
 "Under 91.205(b), what indicator is required if the aircraft has retractable landing gear?",
 "A landing gear position indicator",
 ["A gear warning horn only", "Nothing additional is required",
  "A hydraulic pressure gauge"],
 "91.205(b)(10). It is easy to overlook because it is conditional -- it only applies to retractable-gear aircraft, but it is a day VFR requirement, not an IFR one."),

("91.207", "Required Documents & Equipment", "recall",
 "When must an emergency locator transmitter battery be replaced or recharged?",
 "After 1 cumulative hour of use, or when 50 percent of its useful life has expired",
 ["Every 12 calendar months regardless of use", "After 2 cumulative hours of use",
  "Only when the unit fails a functional test"],
 "91.207(c). The 50-percent rule is what drives the expiration date marked on the transmitter. The ELT itself must also be inspected within 12 calendar months under 91.207(d)."),

("91.209", "Required Documents & Equipment", "recall",
 "During what period must an aircraft display lighted position lights?",
 "From sunset to sunrise",
 ["From 1 hour after sunset to 1 hour before sunrise",
  "From the end of evening civil twilight to the beginning of morning civil twilight",
  "Only when operating at a towered airport"],
 "91.209(a). This is the THIRD definition of night: 1.1 uses civil twilight, 61.57(b) uses 1 hour after sunset, and 91.209 uses plain sunset to sunrise. Examiners love stacking all three."),

("91.213", "Required Documents & Equipment", "recall",
 "Under the Minimum Equipment List path, what must the aircraft records available to the pilot include?",
 "An entry describing the inoperable instruments and equipment",
 ["A signed statement from the manufacturer", "A copy of the airworthiness directive",
  "Nothing -- a placard alone is sufficient"],
 "91.213(a)(4). An MEL plus its letter of authorization together act as a supplemental type certificate for that aircraft, so operating outside its conditions makes the aircraft unairworthy."),

# ── Airworthiness & Inspections ─────────────────────────────────────────────
("91.409", "Airworthiness & Inspections", "recall",
 "How often must an aircraft have an annual inspection?",
 "Within the preceding 12 calendar months",
 ["Within the preceding 12 months to the day", "Every 100 hours of time in service",
  "Within the preceding 24 calendar months"],
 "91.409(a). 'Calendar months' means an annual signed 3 March 2026 is good through 31 March 2027. The 100-hour inspection is a separate requirement that applies only to aircraft carrying persons for hire or giving flight instruction for hire."),

("91.409", "Airworthiness & Inspections", "scenario",
 "You rent an airplane from a flight school and fly it solo for personal travel. Does it need a 100-hour inspection?",
 "Not for your flight -- the 100-hour rule applies to carrying persons for hire or instruction given for hire",
 ["Yes, all rental aircraft need 100-hour inspections",
  "Yes, because money changed hands", "Only if the flight exceeds 100 NM"],
 "91.409(b) is triggered by carrying persons for hire, or by flight instruction for hire in an aircraft the instructor provides. Renting an airplane to fly yourself is neither -- though the school will usually maintain it on a 100-hour cycle anyway."),

("91.411", "Airworthiness & Inspections", "recall",
 "How often must the static pressure system and altimeter be tested for IFR flight in controlled airspace?",
 "Within the preceding 24 calendar months",
 ["Within the preceding 12 calendar months", "Within the preceding 6 calendar months",
  "Every 100 hours of time in service"],
 "91.411(a)(1). Same 24-month clock as the transponder test in 91.413, which is why they are usually done together -- but they are separate requirements and 91.411 applies only to IFR in controlled airspace."),

("91.413", "Airworthiness & Inspections", "recall",
 "How often must an ATC transponder be tested and inspected?",
 "Within the preceding 24 calendar months",
 ["Within the preceding 12 calendar months", "Within the preceding 48 calendar months",
  "Only after maintenance is performed on it"],
 "91.413(a). Unlike 91.411's altimeter check, this applies whenever the transponder is USED -- VFR or IFR -- not only to IFR flight."),

("91.403", "Airworthiness & Inspections", "recall",
 "Who is primarily responsible for maintaining an aircraft in airworthy condition?",
 "The owner or operator",
 ["The pilot in command", "The mechanic who last signed it off",
  "The FAA Flight Standards office"],
 "91.403(a). Contrast 91.7(b), which makes the PILOT IN COMMAND responsible for determining whether the aircraft is in condition for safe flight before and during each flight. Two different people, two different duties."),

("91.7", "Airworthiness & Inspections", "recall",
 "Who is responsible for determining whether the aircraft is in condition for safe flight?",
 "The pilot in command",
 ["The owner", "The mechanic", "The dispatcher"],
 "91.7(b). It also requires the PIC to DISCONTINUE the flight when unairworthy mechanical, electrical, or structural conditions occur -- the duty continues in flight, not just at preflight."),

("43.3", "Airworthiness & Inspections", "recall",
 "May a private pilot who owns an aircraft perform preventive maintenance on it?",
 "Yes, on an aircraft they own or operate, if it is not used in air carrier service",
 ["No, only a certificated mechanic may", "Only with a mechanic supervising",
  "Only if the pilot holds a repairman certificate"],
 "43.3(g). The permitted tasks are the closed list in Part 43 Appendix A(c) -- servicing tires, changing oil, replacing safety wires and light bulbs. Anything outside that list is maintenance, not preventive maintenance."),

# ── Emergency & Special Operations ──────────────────────────────────────────
("91.307", "Emergency & Special Operations", "recall",
 "Carrying a passenger, what maneuvers require everyone to wear an approved parachute?",
 "Bank exceeding 60 degrees, or nose-up/nose-down attitude exceeding 30 degrees",
 ["Bank exceeding 30 degrees, or pitch exceeding 60 degrees",
  "Any spin", "Any maneuver exceeding 45 degrees of bank"],
 "91.307(c). The numbers are 60 bank / 30 pitch and are commonly reversed. The rule does not apply to flight tests for a certificate or rating, or to spins required by regulation for training."),

("91.307", "Emergency & Special Operations", "recall",
 "How recently must a synthetic-fiber emergency parachute have been packed by a certificated rigger?",
 "Within the preceding 180 days",
 ["Within the preceding 60 days", "Within the preceding 120 days",
  "Within the preceding 12 calendar months"],
 "91.307(a)(1). Natural fibers such as silk get only 60 days, because they are far more vulnerable to mold and rot -- which is why the reg splits the interval by material."),

("91.303", "Emergency & Special Operations", "recall",
 "Below what altitude is aerobatic flight prohibited?",
 "1,500 feet above the surface",
 ["1,000 feet above the surface", "2,000 feet above the surface", "500 feet above the surface"],
 "91.303(e). Aerobatics are also barred over congested areas, over open-air assemblies, within Class B/C/D/E surface areas, within 4 NM of a Federal airway centerline, and when visibility is under 3 statute miles."),

("91.303", "Emergency & Special Operations", "recall",
 "What is the minimum flight visibility for aerobatic flight?",
 "3 statute miles",
 ["1 statute mile", "5 statute miles", "There is no visibility requirement"],
 "91.303(f). The section also defines aerobatic flight as an intentional maneuver involving an abrupt change in attitude, an abnormal attitude, or abnormal acceleration not necessary for normal flight."),

# ── Definitions ─────────────────────────────────────────────────────────────
("1.1", "Definitions", "recall",
 "Per 14 CFR 1.1, how is 'night' defined?",
 "The time between the end of evening civil twilight and the beginning of morning civil twilight",
 ["Sunset to sunrise", "1 hour after sunset to 1 hour before sunrise",
  "When the sun is more than 12 degrees below the horizon"],
 "1.1 is the definition used for LOGGING night flight time. It is one of three: 91.209 uses sunset-to-sunrise for position lights, and 61.57(b) uses 1 hour after sunset for night passenger currency."),

("1.1", "Definitions", "recall",
 "Per 14 CFR 1.1, what does 'category' mean when applied to the certification of AIRCRAFT?",
 "A broad classification such as airplane, rotorcraft, glider, or lighter-than-air",
 ["A grouping by engine type", "A grouping such as normal, utility, acrobatic, or transport",
  "A grouping such as single-engine land or multi-engine sea"],
 "1.1 defines 'category' twice with different meanings -- for AIRMEN it is airplane/rotorcraft/glider, and for AIRCRAFT CERTIFICATION it is normal/utility/acrobatic/transport. Which definition applies depends entirely on context."),

("1.1", "Definitions", "recall",
 "Per 14 CFR 1.1, what does 'time in service' mean with respect to maintenance records?",
 "Time from the moment the aircraft leaves the surface until it touches down at the next point of landing",
 ["Time from engine start to engine shutdown", "Time from brake release to brake set",
  "Total flight time logged by the pilot"],
 "1.1. This is why the tach or Hobbs is not automatically 'time in service' -- the 100-hour and other maintenance intervals run on wheels-off to wheels-on time, which is typically shorter."),
]

# ── Batch 2 (2026-09-01): weighted to SCENARIO questions. Batch 1 came out
#    69 recall / 13 scenario, and recall-only is exactly what makes the
#    generated bank read like trivia. Same rule as batch 1: every fact below
#    was written against text read from far_sections.body_text.
Q += [
("91.155", "VFR Weather Minimums", "scenario",
 "You are VFR in Class C airspace with 3 miles visibility, 600 feet below a cloud layer. Is this legal?",
 "Yes -- Class C requires 500 feet below clouds, and 600 feet satisfies that",
 ["No, Class C requires 1,000 feet below clouds", "No, Class C requires 5 statute miles visibility",
  "No, Class C requires you to remain clear of clouds"],
 "Class C cloud clearance is 500 feet BELOW, 1,000 feet ABOVE, 2,000 feet horizontal. The trap is applying the 1,000-foot ABOVE figure to a cloud layer overhead -- you are below the layer, so the 500-foot rule governs and 600 feet clears it. Visibility of 3 statute miles also meets Class C."),

("91.211", "Oxygen & Altitude", "scenario",
 "You are at 14,500 feet MSL in an unpressurized aircraft carrying two passengers. What is required?",
 "The required minimum flight crew must use oxygen for the entire time above 14,000; passengers need not be provided any until 15,000",
 ["All occupants must use oxygen", "Nothing is required below 15,000",
  "Only a 30-minute supply is required for the crew"],
 "91.211(a)(2) removes the 30-minute grace above 14,000 -- crew use is continuous. Passengers only enter the picture at 15,000, and even then they must merely be PROVIDED oxygen, not use it."),

("91.151", "Fuel Requirements", "scenario",
 "A day VFR flight will take 2 hours. Your aircraft burns 10 gallons per hour. What is the minimum usable fuel at takeoff?",
 "25 gallons -- 20 for the flight plus 5 for the 30-minute reserve",
 ["20 gallons", "22.5 gallons", "27.5 gallons"],
 "91.151(a)(1): fuel to the first point of intended landing PLUS 30 minutes at normal cruising speed. 30 minutes at 10 gph is 5 gallons. At night the reserve would be 45 minutes, i.e. 7.5 gallons, for 27.5 total."),

("61.57", "Currency & Flight Review", "scenario",
 "Your last three takeoffs and landings were 100 days ago. May you fly alone today?",
 "Yes -- passenger currency is not required to fly solo",
 ["No, you may not act as PIC at all", "No, you need a flight review first",
  "Only if you stay in the traffic pattern"],
 "61.57(a) restricts carrying PASSENGERS, not flight itself. You may legally fly alone to regain currency -- which is exactly how the rule is designed to be used. A current flight review (61.56) is separately required to act as PIC at all."),

("91.103", "Right-of-Way & Operating Rules", "scenario",
 "You are flying to an airport 80 NM away. Which preflight information does 91.103 specifically require you to check?",
 "Weather reports and forecasts, fuel requirements, alternatives, known traffic delays, plus runway lengths and takeoff/landing distances",
 ["Only the weather at the destination", "Only NOTAMs for the destination",
  "Nothing specific is required for a VFR flight"],
 "91.103(a) and (b). Because this flight is not in the vicinity of the departure airport, the runway length and takeoff/landing distance data in (b) apply -- the part most often skipped on a familiar cross-country."),

("91.205", "Required Documents & Equipment", "scenario",
 "Your landing light burns out before a day VFR flight. Is the aircraft legal to fly?",
 "Potentially yes -- a landing light is not required for day VFR under 91.205(b)",
 ["No, any inoperative equipment grounds the aircraft",
  "Only if a mechanic removes the light first", "Only with an approved MEL"],
 "91.205(b) lists what day VFR requires, and a landing light is not on it (it IS required for night operations for hire under 91.205(c)). Inoperative equipment still has to be handled under 91.213 -- deactivated or removed and placarded -- but its absence alone does not ground the aircraft."),

("91.119", "Altitudes & Speed Limits", "scenario",
 "You are flying over open water and want to descend to 400 feet AGL. Is this permitted?",
 "Yes, provided you remain at least 500 feet from any person, vessel, vehicle, or structure",
 ["No, 500 feet AGL is an absolute floor everywhere",
  "No, 1,000 feet is required over water", "Only if you are conducting a search"],
 "91.119(c). Over open water or sparsely populated areas there is no AGL floor -- the constraint becomes horizontal distance from people and objects. 91.119(a) still requires an altitude allowing an emergency landing without undue hazard."),

("91.117", "Altitudes & Speed Limits", "scenario",
 "You are 3 NM from a Class D primary airport at 2,000 feet AGL. What is your maximum indicated airspeed?",
 "200 knots",
 ["250 knots", "230 knots", "180 knots"],
 "91.117(b): at or below 2,500 feet AGL within 4 NM of the primary airport of Class C or D airspace, the limit is 200 knots. You are inside both the distance and the altitude, so the tighter limit applies rather than the general 250."),

("91.113", "Right-of-Way & Operating Rules", "scenario",
 "You are on final approach. Another aircraft is also on final, below you. Who has the right-of-way?",
 "The lower aircraft -- but it may not cut in front of or overtake the other to take advantage of the rule",
 ["The higher aircraft", "The faster aircraft", "The aircraft that called final first"],
 "91.113(g). The rule gives way to the aircraft at the lower altitude on final, with an explicit anti-abuse clause so nobody dives to claim priority."),

("61.51", "Logbooks & Records", "scenario",
 "You act as safety pilot for a friend practicing under the hood in an aircraft you are rated in. May you log the time?",
 "Yes -- as a required crewmember you may log SIC, and PIC if you are the acting pilot in command by agreement",
 ["No, only the pilot flying may log time", "Only if you are a flight instructor",
  "Only the hood time may be logged"],
 "61.51(f) covers SIC logging; a safety pilot is required by 91.109(c), which makes them a required crewmember. Whether you may log PIC depends on who is the ACTING pilot in command -- that must be agreed before the flight."),

("91.409", "Airworthiness & Inspections", "scenario",
 "Your aircraft's annual was signed 15 April 2026. Through what date is it valid?",
 "30 April 2027",
 ["15 April 2027", "31 December 2026", "15 May 2027"],
 "91.409(a) uses 'within the preceding 12 CALENDAR months', so the inspection is good through the end of the twelfth month. This calendar-month convention appears throughout Part 91 and 61 -- flight review, transponder test, altimeter test -- and is worth reading as 'end of that month' every time."),

("61.23", "Medical & BasicMed", "scenario",
 "A 38-year-old private pilot's third-class medical was issued 10 June 2025. When does it expire for private privileges?",
 "30 June 2030 -- 60 calendar months for a pilot under 40 at the time of the exam",
 ["30 June 2027, 24 calendar months", "30 June 2028, 36 calendar months",
  "30 June 2026, 12 calendar months"],
 "61.23(d). Third-class duration turns on age AT THE TIME OF THE EXAMINATION: under 40 gets 60 calendar months, 40 and over gets 24. Being under 40 on the exam date fixes the longer duration even though the pilot turns 40 during it."),

("91.207", "Required Documents & Equipment", "scenario",
 "Your aircraft's ELT has been in use for 45 minutes cumulative. Must the battery be replaced?",
 "Not on the cumulative-use trigger -- that is 1 hour; but it must still be replaced when 50 percent of useful life expires",
 ["Yes, any use requires replacement", "Yes, 30 minutes is the limit",
  "No, batteries are replaced only every 24 months"],
 "91.207(c) has two independent triggers and either one forces replacement: more than 1 cumulative hour of use, OR 50 percent of useful life expired. The second is what usually drives the date marked on the unit."),

("91.215", "Airspace", "scenario",
 "You want to fly VFR at 9,500 feet MSL, 25 NM from a Class B primary airport. Is a transponder required?",
 "Yes -- you are inside the 30 NM Mode C veil, where a transponder with altitude reporting is required",
 ["No, transponders are only required inside Class B itself",
  "No, they are only required at or above 10,000 feet MSL",
  "Only if you intend to enter Class B"],
 "91.215(b)(2). The Mode C veil is a 30 NM ring around a Class B primary airport from the surface to 10,000 MSL, and it applies whether or not you plan to enter the Class B."),

("91.159", "Altitudes & Speed Limits", "scenario",
 "You are cruising VFR at 6,500 feet MSL on a magnetic course of 010 degrees. Is your altitude correct?",
 "No -- an easterly course requires odd thousands plus 500, such as 5,500 or 7,500",
 ["Yes, 6,500 is correct for that course", "Yes, any altitude is legal VFR",
  "No, you must fly a even thousand with no added 500"],
 "91.159(a)(1): 0 through 179 degrees magnetic takes ODD thousands + 500. 6,500 is an even thousand + 500 and belongs to westerly courses (180-359). Assumes you are more than 3,000 feet above the surface."),

("61.113", "Pilot Certification & Privileges", "scenario",
 "A charity asks you to fly passengers for a fundraising event. May you as a private pilot?",
 "Yes, if the flight meets 91.146 and both the sponsor and pilot comply with it",
 ["No, private pilots may never fly for charity", "Yes, with no conditions at all",
  "Only if you hold a commercial certificate"],
 "61.113(d) points at 91.146, which sets real conditions -- passenger notification, aircraft and pilot requirements, and limits on how often such flights occur. The privilege exists but is not unconditional."),

("91.3", "Emergency & Special Operations", "scenario",
 "An in-flight emergency requires you to deviate from a regulation. What are your obligations?",
 "You may deviate to the extent required to meet the emergency, and must send a written report if the Administrator requests one",
 ["You may not deviate under any circumstances",
  "You must file a written report within 24 hours regardless",
  "You must land at the nearest airport and notify the FSDO"],
 "91.3(b) grants the deviation authority and 91.3(c) makes the written report conditional on the Administrator ASKING. Compare 91.123(c), where an ATC-clearance deviation gets a 48-hour report window on request."),

("43.3", "Airworthiness & Inspections", "scenario",
 "As an aircraft owner with a private certificate, may you replace a landing light and sign it off?",
 "Yes -- that is preventive maintenance, permitted on an aircraft you own or operate and not used under parts 121, 129, or 135",
 ["No, only an A&P may replace a light", "Only under direct supervision of a mechanic",
  "Yes, but a mechanic must sign the logbook entry"],
 "43.3(g), with the permitted tasks listed in Part 43 Appendix A(c). The pilot performing it makes the maintenance record entry themselves under 43.9. Sport pilot certificate holders are excluded from 43.3(g)'s general grant."),

("91.107", "Required Documents & Equipment", "scenario",
 "A passenger refuses to fasten their seatbelt before takeoff. What does 91.107 require of you?",
 "You must ensure each person on board has been notified to fasten their belt before you move, take off, or land",
 ["Nothing -- compliance is the passenger's responsibility",
  "You must physically fasten it for them", "You must offload the passenger"],
 "91.107(a)(2) puts the NOTIFICATION duty on the pilot in command, and 91.107(a)(1) separately requires a briefing on how to fasten and unfasten the belt and harness. The occupant's own duty to keep it fastened is in 91.107(a)(3)."),

("91.121", "Altitudes & Speed Limits", "scenario",
 "You are climbing through 17,500 feet MSL en route to FL200. When do you set 29.92?",
 "At 18,000 feet MSL, the base of Class A airspace",
 ["At 17,500 feet, before entering", "At 14,500 feet", "Only once level at FL200"],
 "91.121(a)(2). Below 18,000 you use a local altimeter setting within 100 NM; at and above 18,000 everyone uses 29.92, which is what turns an altitude into a flight level."),
]
