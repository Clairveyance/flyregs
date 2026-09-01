"""Hand-authored Mechanic question bank (mechanic / airframe / powerplant boxes).

Same rules as the other boxes: written against text read from
far_sections.body_text, and the loader refuses any question it cannot quote.
"""

Q = [
("65.81", "Mechanic Privileges", "recall",
 "What may a certificated mechanic NOT do, even for a rating they hold?",
 "Major repairs to or major alterations of propellers, and any repair to or alteration of instruments",
 ["Any work on engines", "Any work requiring a logbook entry",
  "Any inspection of an airframe"],
 "65.81(a). Those two carve-outs sit inside the general privilege and are easy to miss. Instruments and propeller major work go to appropriately rated repair stations or the manufacturer."),

("65.81", "Mechanic Privileges", "recall",
 "Before supervising work or approving it for return to service, what must a mechanic have done?",
 "Satisfactorily performed that same work at an earlier date, or shown the ability to do it to the Administrator or under direct supervision",
 ["Held the certificate for at least 3 years", "Completed a manufacturer's training course",
  "Nothing beyond holding the applicable rating"],
 "65.81(a). This is the 'you must have done it before' rule -- holding the rating alone is not enough to sign off unfamiliar work."),

("65.83", "Mechanic Recency", "recall",
 "What recent experience must a mechanic have to exercise certificate privileges?",
 "Within the preceding 24 months, either an FAA finding of ability, or at least 6 months serving as, technically supervising, or executively supervising mechanics",
 ["Within the preceding 12 months, 6 months of work",
  "Within the preceding 24 months, 12 months of work",
  "No recent experience is required once certificated"],
 "65.83. Note this is 24 MONTHS, not 24 calendar months, and the qualifying service must total at least 6 months -- any combination of the three activity types counts."),

("65.91", "Inspection Authorization", "recall",
 "What certificates and experience are required to apply for an Inspection Authorization?",
 "A mechanic certificate with BOTH airframe and powerplant ratings, each in effect for a total of at least 3 years",
 ["An airframe rating held for 3 years", "A powerplant rating held for 2 years",
  "A mechanic certificate with either rating held for 5 years"],
 "65.91(c)(1). Both ratings, both currently effective, three years total. It sits alongside (c)(2)'s requirement of active maintenance work for the 2 years before applying."),

("65.91", "Inspection Authorization", "recall",
 "Besides the ratings, what must an IA applicant have been doing for the 2 years before applying?",
 "Actively engaged in maintaining aircraft certificated and maintained in accordance with this chapter",
 ["Working at a certificated repair station", "Supervising at least two other mechanics",
  "Holding an inspection authorization elsewhere"],
 "65.91(c)(2). The applicant must also have a fixed base of operations, the necessary equipment, facilities and inspection data, and must pass a written test."),

("43.9", "Maintenance Records", "recall",
 "What four items must a maintenance record entry contain?",
 "A description of the work performed, the date of completion, the name of the person doing the work if different, and the signature, certificate number, and kind of certificate of the person approving it",
 ["Only a description of the work and the date",
  "Only the signature and certificate number",
  "The work performed, the date, and the aircraft total time"],
 "43.9(a). The signature constitutes the approval for return to service -- and only for the work actually performed, which is why a broad sign-off is not a blanket airworthiness statement."),

("43.3", "Maintenance Authority", "recall",
 "Who may perform maintenance under the supervision of a certificated mechanic or repairman?",
 "A person working under that holder's supervision, if the supervisor personally observes the work and is readily available in person for consultation",
 ["Anyone, with no conditions", "Only another certificated mechanic",
  "Only an apprentice enrolled in a Part 147 school"],
 "43.3(d). Two conditions apply together -- personal observation to the extent necessary, and being readily available IN PERSON. That paragraph explicitly does NOT authorize any Part 91 or 125 required inspection, nor an inspection after a major repair or alteration."),

("91.403", "Maintenance Responsibility", "recall",
 "Who is primarily responsible for maintaining an aircraft in an airworthy condition?",
 "The owner or operator",
 ["The pilot in command", "The certificated mechanic who last worked on it",
  "The FAA Flight Standards office"],
 "91.403(a). Contrast 91.7(b), which puts the duty to DETERMINE that the aircraft is in condition for safe flight on the pilot in command before and during each flight. Two different people, two different duties, frequently conflated."),
]
