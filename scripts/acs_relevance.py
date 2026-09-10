"""Shared scoring core for ACS task -> regulation relevance.

WHY THIS EXISTS
---------------
RC, 2026-09-09: inside CFI prep, Task I.A "Effects of Human Behavior and
Communication on the Learning Process" showed AC 90-117 "Data Link
Communications" as a related reg. It ranked #1 at ts_rank 104.4 purely because
the single word "communication" appears in both titles. The task is about
teaching psychology; AC 90-117 is about datalink avionics.

Two things were wrong, and both are fixed here:

1. THE QUERY WAS THE TASK TITLE ALONE. A title is 6-10 words, so one generic
   word can carry an entire match. Every ACS task also has Knowledge / Risk
   Management / Skill elements (23,274 rows corpus-wide) that describe what the
   task is actually about -- Task I.A's elements say "motivation", "defense
   mechanisms", "anxiety and stress", "teaching the adult learner". Scoring
   against that full text instead of the title makes the task's real subject
   dominate.

2. AN ABSOLUTE RANK FLOOR CANNOT WORK. refPackSearch.ts already proved this in
   its own comments: real matches score in the hundreds-to-thousands, but so do
   some genuinely wrong ones, and there is no single ts_rank value that
   separates them across arbitrary natural-language titles. So this module does
   not threshold on a score at all. It requires EVIDENCE:

     * >= MIN_DISTINCT_TERMS distinct significant task terms must appear, so no
       single shared word can ever carry a match on its own; and
     * >= 1 of them must be SPECIFIC (IDF at or above the corpus median), so two
       generic words cannot substitute for one meaningful one; and
     * the score must reach MIN_SCORE_FRACTION of the best score for that task,
       which is relative and therefore scale-free.

Titles are weighted far above body text: a section TITLED "Medical
certificates: Requirement and duration" is about medical certificates; one that
merely mentions the word in passing is not.
"""
import math
import re
from collections import Counter

# ONLY function words and pure ACS-template boilerplate.
#
# An earlier version of this list also stripped aviation vocabulary --
# "aircraft", "flight", "pilot", "certificate", "requirement" -- on the theory
# that they were too common to carry signal. That was wrong twice over. IDF
# already demotes a term that appears everywhere, automatically and with far
# more nuance than a hand-written list. And the list removed exactly the words
# that DEFINE certification topics: with "pilot" and "certificate" stopped,
# CFI Task III.A "Pilot Qualifications" scored ZERO against every section of
# Part 61 it cites, including 61.23 "Medical certificates". Let IDF do this job.
#
# What survives here is text that comes from the ACS template rather than from
# the subject: every task says "understands", "risk management", "skill".
STOPWORDS = set("""
a an and are as at be been before being between both but by can could did do does doing
during each either few for from further had has have having he her here hers him his how
however i if in into is it its itself just may me might more most must my no nor not of
off on once only or other our out over own same shall she should so some such than that
the their them then there these they this those through to too under until up upon very
was we were what when where whether which while who whom why will with within without
would you your
must may shall should will
understand understands understanding determine determining demonstrate demonstrating
applicant associated appropriate ability including include includes
knowledge risk management skill skills elements element
""".split())

TOKEN = re.compile(r"[a-z][a-z0-9'-]{2,}")


def stem(w: str) -> str:
    """Deliberately crude suffix stripping -- enough to bind
    'endorsement/endorsements' and 'log/logging/logbook' without pulling in a
    stemmer dependency. Over-stemming is safer here than under-stemming
    because the evidence rules downstream still require multiple distinct
    terms to agree."""
    for suf in ("ations", "ation", "ings", "ing", "ies", "ers", "er", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def terms(text: str) -> list:
    return [stem(t) for t in TOKEN.findall((text or "").lower()) if t not in STOPWORDS]


def term_set(text: str) -> set:
    return {t for t in terms(text) if t not in STOPWORDS}


def build_idf(docs) -> dict:
    """docs: iterable of already-tokenised term sets."""
    n = 0
    df = Counter()
    for d in docs:
        n += 1
        df.update(d)
    return {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}, n


# --- tuning ------------------------------------------------------------------
# Each of these was set from observed behaviour on the corpus, not guessed;
# validate_acs_reg_links.py re-checks them against known-good/known-bad tasks.
MIN_DISTINCT_TERMS = 2      # kills the single-shared-word match ("communication")
BROAD_AGREEMENT_TERMS = 5   # ...but many independent terms agreeing is evidence on its own
MIN_SCORE_FRACTION = 0.12   # relative, so it is immune to ts_rank scale drift
TITLE_WEIGHT = 3.0          # a section's title states its subject; its body merely mentions things
MAX_PER_TYPE = 8


def score_candidate(task_terms_w: dict, cand_title: str, cand_body: str,
                    idf: dict, median_idf: float):
    """Returns (score, n_distinct_matched, has_specific_term).

    task_terms_w maps term -> weight (task-side emphasis: title/knowledge
    elements count for more than skill boilerplate).
    """
    t_title = term_set(cand_title)
    body_counts = Counter(terms(cand_body))

    score = 0.0
    matched = set()
    specific = False
    for t, w in task_terms_w.items():
        i = idf.get(t)
        if i is None:
            continue
        hit = False
        if t in t_title:
            score += w * i * TITLE_WEIGHT
            hit = True
        tf = body_counts.get(t, 0)
        if tf:
            # saturating term frequency -- a section that says the word 40 times
            # is not 40x more relevant than one that says it three times.
            score += w * i * min(tf, 3) / 3.0
            hit = True
        if hit:
            matched.add(t)
            if i >= median_idf:
                specific = True
    # Whether ANY task term reached the candidate's own TITLE. See
    # `title_overlap_required` below for why this is reported separately.
    title_hit = bool(matched & t_title)
    return score, len(matched), specific, title_hit


def passes_evidence(n_matched: int, specific: bool, title_hit: bool = True,
                    require_title: bool = False) -> bool:
    """Two independent ways to clear the bar, because either alone is wrong.

    THIRD CONDITION, 2026-09-10, `require_title`. A task term must appear in the
    candidate's own TITLE, not merely somewhere in its body. Added after
    auditing output rather than code: the ATP Powered-Lift ACS task "Normal
    Approach and Landing" was linked to § 91.611 "Authorization for ferry
    flight with one engine inoperative", which shares no title word with the
    task at all -- it scored purely on body prose ("flight", "operations",
    "airplane"). A section whose TITLE is about something else is not the
    section a student should open for this task. Off by default so the two
    corpora that do not need it are unaffected.

    A rare term agreeing (`specific`) is strong evidence from one word. But so
    is a large number of ordinary terms agreeing: CFI Task III.A "Pilot
    Qualifications" matches 61.23 "Medical certificates" on 28 distinct terms --
    certificate, medical, class, expiration, privileges, student, sport,
    private, commercial ... -- and not one of them clears the corpus-wide
    median IDF, because in a corpus of regulations those words are common
    everywhere. Requiring a rare term rejected it, which is plainly wrong.

    Requiring BOTH would have thrown away almost every correct Part 61 link
    (63 of 423 FAR-citing tasks got any link at all). Requiring EITHER keeps
    the guard that matters: the AC 90-117 false positive matched exactly ONE
    term ("communication"), so it fails both branches and always will.
    """
    if require_title and not title_hit:
        return False
    if n_matched >= BROAD_AGREEMENT_TERMS:
        return True
    return n_matched >= MIN_DISTINCT_TERMS and specific
