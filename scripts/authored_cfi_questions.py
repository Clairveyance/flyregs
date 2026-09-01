"""Hand-authored CFI question bank.

Same rules as the other boxes: written against text read from
far_sections.body_text, and the loader refuses any question it cannot quote.

Weighted toward the record-keeping and recency rules, which are where CFIs
actually get into trouble and which the generated bank covers poorly.
"""

Q = [
("61.183", "CFI Eligibility", "recall",
 "What is the minimum age for a flight instructor certificate?",
 "18 years of age",
 ["17 years of age", "21 years of age", "16 years of age"],
 "61.183(a). Same as the commercial minimum in 61.123(a), which makes sense -- 61.183(c) requires you already hold a commercial or ATP certificate."),

("61.183", "CFI Eligibility", "recall",
 "What pilot certificate must a flight instructor applicant already hold?",
 "A commercial pilot certificate or an airline transport pilot certificate with the appropriate category and class rating",
 ["A private pilot certificate with 250 hours", "Any pilot certificate plus an instrument rating",
  "A commercial certificate only, never an ATP"],
 "61.183(c). For an airplane single-engine instructor rating it must also carry an instrument rating (or appropriate privileges) -- you cannot teach toward something you are not yourself rated for."),

("61.193", "CFI Privileges", "recall",
 "What is a flight instructor authorized to do within the limits of their certificate and ratings?",
 "Conduct ground and flight training, certain checking events, and issue endorsements for certificates, ratings, flight reviews, and tests",
 ["Only conduct flight training, never ground training",
  "Only endorse students for solo, never for practical tests",
  "Conduct training only toward the certificates the instructor personally holds"],
 "61.193(a). The list spans student pilot certificates through flight instructor and ground instructor certificates, instrument ratings, flight reviews, recency of experience, and both knowledge and practical tests."),

("61.189", "CFI Records", "recall",
 "What records must a flight instructor maintain beyond signing student logbooks?",
 "The name and date for each person endorsed for solo, and the name, kind of test, date, and results for each person endorsed for a knowledge or practical test",
 ["Only a list of students taught", "Only the endorsements for practical tests",
  "Only a record of flight hours given"],
 "61.189(b). This is a record the instructor keeps separately -- signing the student's own logbook under (a) does not satisfy it, because the student takes that logbook with them."),

("61.189", "CFI Records", "recall",
 "How long must a flight instructor retain the records required by 61.189?",
 "At least 3 years",
 ["At least 1 year", "At least 2 years", "At least 5 years"],
 "61.189(c). Three years, and the obligation survives the student moving on -- which is exactly why (b) requires the instructor's own separate record rather than relying on the student's logbook."),

("61.189", "CFI Records", "scenario",
 "A former student's certificate action prompts the FAA to ask for your endorsement records from 2 years ago. Must you produce them?",
 "Yes -- 61.189(c) requires the records be retained at least 3 years",
 ["No, records need only be kept 1 year", "No, once the student solos the record may be discarded",
  "Only if you are still actively instructing"],
 "61.189(c). Two years is inside the three-year window, and the requirement does not lapse because you stopped instructing or the student moved on."),

("61.197", "CFI Recency", "recall",
 "How often must a flight instructor establish recent experience to exercise instructor privileges?",
 "Within the preceding 24 calendar months",
 ["Within the preceding 12 calendar months", "Within the preceding 36 calendar months",
  "Within the preceding 6 calendar months"],
 "61.197(a). Same 24-calendar-month rhythm as the flight review in 61.56, but a completely separate requirement -- a current flight review does not renew a CFI certificate."),

("61.197", "CFI Recency", "recall",
 "If a CFI accomplishes the recency requirements EARLY, when does the new 24-month period start?",
 "From the last month of the current recent experience period, provided the requirements are met within the 3 calendar months preceding it",
 ["From the month the requirements were accomplished, always",
  "From the month the certificate was originally issued, always",
  "Early completion is not permitted"],
 "61.197(a)(3). This 3-month grace is what lets a CFI renew early without losing time off the certificate -- the same idea as an early flight review, but written explicitly into the rule."),

("61.195", "CFI Limitations", "recall",
 "What must a flight instructor hold to give training in an aircraft for a certificate or rating?",
 "The applicable category and class rating on BOTH the flight instructor certificate and the pilot certificate",
 ["Only the appropriate rating on the flight instructor certificate",
  "Only the appropriate rating on the pilot certificate",
  "Any instructor rating, provided the student is rated"],
 "61.195(b)(1) and (b)(2). Both certificates must carry the applicable category and class rating -- the regulation says category and class, not type. This is the rule behind the common trap of a CFI with a single-engine instructor rating trying to give multiengine training. Instrument training has its own separate conditions in 61.195(c)."),

("61.185", "CFI Knowledge", "recall",
 "What aeronautical knowledge areas must a flight instructor applicant have received training on?",
 "The fundamentals of instructing plus the aeronautical knowledge areas for the certificate and rating sought",
 ["Only the fundamentals of instructing",
  "Only the knowledge areas for the rating sought",
  "Only aviation regulations and airspace"],
 "61.185(a). The fundamentals of instructing -- the learning process, teaching methods, evaluation -- are what make the CFI knowledge test different from every other pilot test."),
]
