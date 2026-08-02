#!/usr/bin/env python3
"""SmartSearch BREADTH test — how many ways can a real person ask for a reg?

The curated bench (smartsearch_bench.py) proves the known-hard cases stay
fixed. This one probes the SHAPE of the input space instead, because a pilot
typing on a phone in a run-up area does not phrase things like a lawyer.

Categories deliberately include inputs the system should be BAD at, so the
score is honest rather than flattering:

  exact      the literal title or number
  partial    a truncated word ("transpond", "oxy")
  shorthand  cockpit abbreviations ("wx mins", "xwind", "pic")
  everyday   the non-FAA word for the thing ("gas", "drunk", "puke")
  question   a whole spoken question
  jargon     hangar-talk ("bottle to throttle", "hood time")
  multi      two concepts at once ("night VFR fuel")
  typo       plausible misspellings
  numeric    section/part numbers

Usage:
  python3 scripts/smartsearch_breadth.py                # full report
  python3 scripts/smartsearch_breadth.py --fails        # only failures
"""
import json
import os
import sys
import urllib.error
import urllib.request
from collections import defaultdict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]



# ---- mirror the CLIENT pipeline ------------------------------------------
# The app doesn't hit the RPC with the raw query alone: searchSynonyms.ts
# expands it (bridge -> corpus associations -> morphology) and searches every
# expansion alongside it, merging the results. Testing the bare RPC therefore
# UNDERSTATES what the user actually experiences, especially for everyday
# wording. This reads the real bridge map out of src/lib/searchBridge.ts and
# applies the same whole-word rule the TS does, so the benchmark measures the
# pipeline rather than one layer of it.
import re as _re

def _load_bridge():
    src = open(os.path.join(BASE, "src/lib/searchBridge.ts")).read()
    body = src[src.index("USER_TO_FAA"):src.index("// Returns the FAA-vocabulary")]
    out = {}
    for m in _re.finditer(r"^\s*'?([a-z0-9 .\-/]+)'?\s*:\s*\[([^\]]*)\]", body, _re.M):
        key = m.group(1).strip()
        vals = [v.strip().strip("'\"") for v in m.group(2).split(",") if v.strip()]
        if key and vals:
            out[key] = vals
    return out

BRIDGE = _load_bridge()

def bridge_terms(query):
    q = " ".join(query.lower().split())
    if q in BRIDGE:
        return [t for t in BRIDGE[q] if t != q][:6]
    out, seen = [], set()
    for key in sorted(BRIDGE, key=len, reverse=True):
        if len(out) >= 6:
            break
        if not _re.search(r"(^|[^a-z0-9])" + _re.escape(key) + r"([^a-z0-9]|$)", q):
            continue
        for t in BRIDGE[key]:
            tl = t.lower()
            if tl in q or tl in seen:
                continue
            seen.add(tl)
            out.append(t)
    return out[:6]


def rpc(fn, params):
    req = urllib.request.Request(
        f"{URL}/rest/v1/rpc/{fn}", data=json.dumps(params).encode(), method="POST")
    req.add_header("apikey", SERVICE)
    req.add_header("Authorization", f"Bearer {SERVICE}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode() or "[]")
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:200]}


# (category, query, type, expected_id) — expected within top 5.
CASES = [
    # ---- exact-ish -----------------------------------------------------
    ("exact", "Aircraft speed", "far", "91.117"),
    ("exact", "Right-of-way rules: Except water operations", "far", "91.113"),
    ("exact", "Fuel requirements for flight in VFR conditions", "far", "91.151"),
    ("exact", "Supplemental oxygen", "far", "91.211"),
    ("exact", "Emergency locator transmitters", "far", "91.207"),

    # ---- partial words -------------------------------------------------
    ("partial", "transpond", "far", "91.215"),
    ("partial", "oxy", "far", "91.211"),
    ("partial", "altimet", "far", "91.121"),
    ("partial", "aerobat", "far", "91.303"),
    ("partial", "parachut", "far", "91.307"),

    # ---- cockpit shorthand ---------------------------------------------
    ("shorthand", "wx mins", "far", "91.155"),
    ("shorthand", "vfr mins", "far", "91.155"),
    ("shorthand", "pic responsibility", "far", "91.3"),
    ("shorthand", "elt battery", "far", "91.207"),
    ("shorthand", "mode c veil", "far", "91.215"),
    ("shorthand", "bfr", "far", "61.56"),

    # ---- everyday words for FAA concepts -------------------------------
    ("everyday", "how much gas do I need", "far", "91.151"),
    ("everyday", "flying drunk", "far", "91.17"),
    ("everyday", "can I do loops", "far", "91.303"),
    ("everyday", "jumping out of a plane", "far", "91.307"),
    ("everyday", "flying too low", "far", "91.119"),
    ("everyday", "seat belt rules", "far", "91.107"),

    # ---- spoken questions ----------------------------------------------
    ("question", "do I need oxygen at 13000 feet", "far", "91.211"),
    ("question", "when does my medical expire", "far", "61.23"),
    ("question", "how often do I need a flight review", "far", "61.56"),
    ("question", "who has the right of way", "far", "91.113"),
    ("question", "can I fly if I had a drink", "far", "91.17"),
    ("question", "what instruments do I need for VFR", "far", "91.205"),

    # ---- hangar jargon --------------------------------------------------
    ("jargon", "bottle to throttle", "far", "91.17"),
    ("jargon", "hood time", "far", "91.109"),
    ("jargon", "night currency", "far", "61.57"),
    ("jargon", "annual", "far", "91.409"),
    ("jargon", "squawk 7700", "aim", "6-2-2"),

    # ---- multi-concept ---------------------------------------------------
    ("multi", "night vfr fuel reserve", "far", "91.151"),
    ("multi", "class b equipment requirements", "far", "91.131"),
    ("multi", "ifr alternate weather minimums", "far", "91.169"),
    ("multi", "oxygen for passengers above 15000", "far", "91.211"),

    # ---- typos -----------------------------------------------------------
    ("typo", "altimiter setting", "far", "91.121"),
    ("typo", "transponder requirments", "far", "91.215"),
    ("typo", "oxigen", "far", "91.211"),

    # ---- numeric ---------------------------------------------------------
    ("numeric", "91.3", "far", "91.3"),
    ("numeric", "91.155", "far", "91.155"),
    ("numeric", "61.57", "far", "61.57"),
    ("numeric", "4-3-13", "aim", "4-3-13"),
]

TYPE_FN = {
    "far": ("search_far", "section_number"),
    "aim": ("search_aim", "paragraph_number"),
    "pcg": ("search_pcg", "term"),
    "ac":  ("search_acs", "document_number"),
}


STOPWORDS = {
    'a','an','the','and','or','of','to','in','on','at','for','from','by','with',
    'is','are','be','do','does','did','i','my','me','can','may','must','need',
    'needs','what','when','where','who','why','how','if','it','this','that',
    'you','your','have','has','am','was','were','about','into','over','under',
    'much','many',
}


def _content_terms(q):
    all_w = [w for w in q.split() if w]
    kept = [w for w in all_w if w not in STOPWORDS and (len(w) >= 3 or w.isdigit())]
    return kept or all_w


def _word_in(text, word):
    return _re.search(r"(^|[^a-z0-9])" + _re.escape(word) + r"([^a-z0-9]|$)", text) is not None


def _tier(query, identifier, title):
    """Mirror of src/lib/searchRank.ts relevanceTier()."""
    q = " ".join(query.lower().split())
    terms = _content_terms(q)
    num = (identifier or "").lower()
    t = (title or "").lower()
    norm = lambda x: " ".join((x or "").lower().split()).rstrip(".")
    if num == q or norm(identifier) == q or norm(title) == q:
        return 0, 0
    if num.startswith(q):
        return 1, 0
    if q in num:
        return 2, 0
    hits = sum(1 for x in terms if _word_in(t, x))
    if terms and hits == len(terms):
        return 3, hits
    return (4, hits) if hits else (5, 0)


def position(query, typ, want, limit=25):
    """Position in the ranked list the app actually renders: literal query
    plus each bridge expansion, de-duplicated, then ordered by the BETTER of
    (tier vs the raw query, tier vs the term that found it)."""
    fn, col = TYPE_FN[typ]
    found, seen = [], set()
    for term in [query] + bridge_terms(query):
        rows = rpc(fn, {"query": term, "result_limit": limit})
        if isinstance(rows, dict):
            continue
        for r in rows:
            rid = str(r.get(col))
            if rid in seen:
                continue
            seen.add(rid)
            title = r.get("title") or r.get("term") or ""
            d_tier, d_hits = _tier(query, rid, title)
            # Expansions only rescue a result the literal query couldn't
            # place at all (tier 5). See the note in (tabs)/index.tsx.
            if term != query and d_tier >= 4:
                v_tier, v_hits = _tier(term, rid, title)
                if v_tier <= 3 and v_tier < d_tier:
                    d_tier, d_hits = v_tier, v_hits
            anchored = bool(r.get("is_anchor"))
            found.append((0 if anchored else d_tier, -d_hits, len(found), rid))
    found.sort()
    ids = [x[3] for x in found]
    return ids.index(want) + 1 if want in ids else None


def main():
    only_fails = "--fails" in sys.argv
    by_cat = defaultdict(lambda: [0, 0])
    failures = []
    for cat, query, typ, want in CASES:
        pos = position(query, typ, want)
        ok = pos is not None and pos <= 5
        by_cat[cat][0] += 1 if ok else 0
        by_cat[cat][1] += 1
        line = f"  {'ok ' if ok else 'MISS'} [{cat:9}] {query[:42]:42} -> {typ}:{want:9} {('#' + str(pos)) if pos else 'not found'}"
        if not ok:
            failures.append(line)
        if not only_fails:
            print(line)

    print("\n" + "=" * 72)
    print(f"{'category':12} {'top-5':>8}")
    tot_ok = tot = 0
    for cat, (ok, n) in sorted(by_cat.items(), key=lambda kv: -kv[1][0] / kv[1][1]):
        tot_ok += ok
        tot += n
        bar = "#" * round(10 * ok / n)
        print(f"{cat:12} {ok:>3}/{n:<3} {bar}")
    print("-" * 72)
    print(f"{'TOTAL':12} {tot_ok:>3}/{tot:<3}  ({100*tot_ok/tot:.0f}%)")
    if failures:
        print(f"\n{len(failures)} miss(es):")
        for f in failures:
            print(f)
    sys.exit(0)


if __name__ == "__main__":
    main()
