#!/usr/bin/env python3
"""Aviation Dictionary's informal/slang tier ("hangar talk").

Different risk profile from every other tier in this pipeline: contractions,
Appendix B, and the prose glossaries all TRANSCRIBE real FAA source text
(validated against the source, faithfully reproduced). This tier has no
single authoritative source -- it asks the model to draw on general
aviation-culture knowledge instead. RC, explicit go-ahead (2026-08-01):
"Build it, LLM-generated" from a proposed ~150-300 term, clearly-labeled
scope (not the corpus-wide "thousands" scale of the sourced tiers).

Mitigations for the accuracy risk a sourced tier doesn't need:
1. Bounded scope, split into 5 thematic prompts (~30-40 terms each) rather
   than one big "list everything" call -- keeps the model focused on terms
   it's actually confident are real and in use, not padding toward a count.
2. System prompt explicitly forbids inventing plausible-sounding but
   fictional terms, and requires ONLY terms in widespread real use.
3. category='informal' is a distinct value from 'contraction'/'handbook' --
   the app surfaces this as a visibly different "informal usage" tag,
   never presented with the same authority as the FAA-sourced tiers.
4. Deduped against all 5,051 existing terms before insert.
5. Every entry gets hand spot-checked after load (same as the prose
   glossary tier), since there's no source doc to check against instead.

Usage:
  python3 sync/generate_dictionary_informal.py --dry-run
  python3 sync/generate_dictionary_informal.py
"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, mgmt_sql  # noqa: E402

MODEL = "claude-sonnet-5"

SYSTEM = """You are an expert on real, widely-used aviation slang and informal terminology -- the kind pilots, mechanics, and controllers actually say to each other, not formal FAA/ICAO terminology (that's covered elsewhere).

STRICT RULES:
1. Only include terms you are genuinely confident are REAL and IN ACTUAL, WIDESPREAD USE in aviation culture. Do NOT invent a plausible-sounding term just to fill a quota -- if you're not sure a term is real and commonly used, leave it out.
2. Every definition must be factually accurate and written in a neutral, factual tone -- no jokes, no editorializing.
3. Skip anything offensive, discriminatory, or that could be read as encouraging unsafe practices.
4. Skip anything that's actually formal FAA/ICAO terminology (e.g. "squawk" is borderline formal already covered elsewhere -- skip terms like that; focus on genuinely informal shop-talk/ramp-talk/hangar-talk).
5. Each entry needs: term (the slang word/phrase as commonly written), definition (one clear sentence explaining what it means and where/how it's used).

Respond with JSON only, matching the schema."""

SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"term": {"type": "string"}, "definition": {"type": "string"}},
                "required": ["term", "definition"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["entries"],
    "additionalProperties": False,
}

CATEGORIES = [
    ("Flying & landings", "Slang about flight maneuvers, landings, and general flying (e.g. terms for a smooth or rough landing, common pilot expressions during flight)."),
    ("Aircraft & maintenance", "Slang used by mechanics and pilots about aircraft, parts, and maintenance (e.g. nicknames for aircraft types, maintenance/hangar terminology)."),
    ("Airports & ramp", "Slang about airports, the ramp, ground operations, and airport culture."),
    ("ATC & radio culture", "Informal terms and expressions used around radio communication and air traffic control culture (NOT formal phraseology -- that's covered elsewhere)."),
    ("General aviation culture", "General pilot/aviation-community slang, nicknames, and informal expressions not covered by the other categories -- weather, career, community terms."),
]


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


# Hand-reviewed after a real dry-run (2026-08-01) -- the system prompt's
# anti-hallucination rules didn't catch everything. Excluded, each for a
# specific reason (not just "didn't like it"):
#   - near-duplicates of a term already kept ("Widow maker" of "Widowmaker",
#     "the boneyard" of "Boneyard", "Line guy/gal" of "Line guy/line crew")
#   - formal FAA/ICAO phraseology that slipped past rule #4 ("Say your
#     altitude", "Contact tower", "Say intentions", "Say again", "Cleared
#     as filed" -- these are P/CG-level standard phraseology, not slang)
#   - formal regulatory/certification terms, not slang ("Type rating",
#     "Currency", "Chandelle" and "Departure stall" -- both real ACS/PTS
#     maneuver names, not informal coinages)
#   - a specific corporate trademark presented as if it were generic slang
#     ("red carpet club" was a real United Airlines product name; "Skunk
#     works" originates the same way, from Lockheed's specific division)
#   - low-confidence, plausible-sounding but not verifiably real/widespread
#     ("Cactus" had an incoherent definition; "Nose dragger", "Fly-by-wire
#     jockey", "Death cruise", "Mic fright", "Numbers are good" read as
#     backformations invented to fill the quota, not terms in real use)
#   - not actually aviation-specific slang, just a general English idiom or
#     a plain description rather than a real headword ("Talking heads",
#     "Chatty Cathy", "Talk fast", "Talk to me", "Working frequency",
#     "Frequency congestion", "Cowling" -- that entry was about a formal
#     part name, not a slang term itself)
EXCLUDE_TERMS = {
    "widow maker", "the boneyard", "line guy/gal", "say your altitude",
    "contact tower", "say intentions", "say again", "cleared as filed",
    "type rating", "currency", "chandelle", "departure stall",
    "red carpet club", "skunk works", "cactus", "nose dragger",
    "fly-by-wire jockey", "death cruise", "mic fright", "numbers are good",
    "talking heads", "chatty cathy", "talk fast", "talk to me",
    "working frequency", "frequency congestion", "cowling",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    existing_terms_lower = {r["term"].lower() for r in mgmt_sql("select term from dictionary_terms")}

    # Cached from the real generation run (2026-08-01, 5 requests, $0.0519
    # total, Sonnet 5) -- reused here rather than re-calling the API, since
    # RC asked to be told before any further LLM spend and the exact same
    # (already hand-reviewed) content is what should load anyway. Delete
    # this cache file and re-add the live API call above it if the
    # categories/prompt ever need to change and a fresh generation is
    # actually wanted.
    cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".dictionary_sources", "informal_raw_cache.json")
    all_entries = [(term, defn, label) for label, term, defn in json.load(open(cache_path, encoding="utf-8"))]
    print(f"Loaded {len(all_entries)} cached raw entries from {cache_path} (no API call made).")

    # Dedupe within this run (case-insensitive), against existing
    # dictionary_terms, AND against the hand-reviewed exclude list above.
    seen, rows = set(), []
    for term, defn, category_label in all_entries:
        key = term.lower()
        if key in seen or key in existing_terms_lower or key in EXCLUDE_TERMS:
            continue
        seen.add(key)
        rows.append({
            "term": term,
            "slug": f"slang-{slugify(term)}",
            "letter": term[0].upper() if term[0].isalpha() else "#",
            "category": "informal",
            "senses": [{"definition": defn, "usage": None}],
            "source": f"LLM-generated (general aviation-culture knowledge, category: {category_label}) -- not FAA-sourced, informal usage only",
        })
    print(f"{len(rows)} after dedup (within-run + against existing {len(existing_terms_lower)} terms).")

    if args.dry_run:
        for r in rows:
            print(f"  {r['term']}: {r['senses'][0]['definition']}")
        return

    BATCH = 500
    upserted = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status not in (200, 201, 204):
            print(f"  chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            upserted += len(chunk)
    print(f"Upserted {upserted} rows into dictionary_terms.")


if __name__ == "__main__":
    main()
