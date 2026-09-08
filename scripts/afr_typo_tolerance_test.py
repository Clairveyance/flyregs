#!/usr/bin/env python3
"""Ask FlyRegs must survive a typo -- and must not invent one where none exists.

RC, 2026-09-08: he typed "Can I go around with a lasso" (autocorrect had eaten
LAHSO) and got 15 results, none about hold-short operations. Spelled correctly,
AIM 4-3-11 is first.

Two halves, and the SECOND is the one that matters more:
  1. Typos now reach the right document.
  2. Correctly-spelled queries are UNCHANGED. The fuzzy anchor pass runs only
     when the strict pass matched nothing, so by construction it cannot alter a
     query that already worked -- this test is what keeps that true.

Runs against the real edge function as a real signed-in user, because
hybrid_search is reached through semantic-search and nothing else proves the
path a user actually takes.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(fn):
    d = {}
    for line in open(os.path.join(BASE, fn)):
        line = line.strip().removeprefix("export ")
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            d[k] = v.strip().strip('"').strip("'")
    return d


E = load(".env.scraper"); URL = E["SUPABASE_URL"]; SVC = E["SUPABASE_SERVICE_KEY"]
ANON = load(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]


def call(u, b=None, h=None):
    r = urllib.request.Request(u, data=json.dumps(b).encode() if b is not None else None,
                               headers=h or {}, method="POST" if b is not None else "GET")
    try:
        with urllib.request.urlopen(r, timeout=45) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def session():
    H = {"apikey": SVC, "Authorization": "Bearer " + SVC, "Content-Type": "application/json"}
    _, b = call(f"{URL}/auth/v1/admin/generate_link",
                {"type": "magiclink", "email": "tiermatrix-pro@flyregs.invalid"}, H)
    link = json.loads(b)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    _, b = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                {"apikey": ANON, "Content-Type": "application/json"})
    return json.loads(b)["access_token"]


# (query, doc_type, doc_id that must appear in the top N)
TYPOS = [
    ("Can I go around with a lasso",  "aim", "4-3-11"),   # RC's report
    ("do i need oxigen at 13000",     "far", "91.211"),
    ("preflght action required",      "far", "91.103"),
    ("transponer inoperative",        "far", "91.215"),
    ("hypoxa symptoms",               "aim", "8-1-2"),
]
# Correctly spelled -- these must keep landing where they already did.
CORRECT = [
    ("land and hold short operations", "aim", "4-3-11"),
    ("supplemental oxygen requirements", "far", "91.211"),
    ("preflight action",               "far", "91.103"),
    ("flight review",                  "far", "61.56"),
    ("alcohol eight hours",            "far", "91.17"),
    ("ELT battery replacement",        "far", "91.207"),
    ("class G airspace weather minimums", "far", "91.155"),
    ("aerobatic flight limitations",   "far", "91.303"),
    ("logging pilot in command time",  "far", "61.51"),
    ("BasicMed requirements",          "far", "61.113"),
]
# Ordinary words that sit one edit from an anchor. These must NOT be bent.
NO_BEND = [
    ("what are the crew roles", "far", "91.303"),   # roles -> rolls (aerobatic) would be wrong
]


def main():
    tok = session()
    H = {"apikey": ANON, "Authorization": "Bearer " + tok, "Content-Type": "application/json"}

    def top(q, n=5):
        st, b = call(f"{URL}/functions/v1/semantic-search", {"query": q}, H)
        if st != 200:
            raise SystemExit("FAIL  %r -> HTTP %s: %s" % (q, st, b[:200]))
        return [(r["source_type"], r["source_id"]) for r in json.loads(b).get("results", [])[:n]]

    fails = []

    print("=== 1. typos now reach the right document (top 5) ===")
    for q, dt, did in TYPOS:
        hits = top(q)
        ok = (dt, did) in hits
        print("  %s %-32s expect %s %-8s %s" % ("PASS " if ok else "FAIL ", q[:32], dt, did,
                                                "" if ok else "got " + str(hits[:3])))
        if not ok:
            fails.append(q)

    print()
    print("=== 2. correctly-spelled queries are unchanged (top 5) ===")
    for q, dt, did in CORRECT:
        hits = top(q)
        ok = (dt, did) in hits
        print("  %s %-32s expect %s %-8s %s" % ("PASS " if ok else "FAIL ", q[:32], dt, did,
                                                "" if ok else "got " + str(hits[:3])))
        if not ok:
            fails.append(q)

    print()
    print("=== 3. a real word is never bent into an anchor ===")
    for q, dt, did in NO_BEND:
        hits = top(q)
        ok = (dt, did) not in hits
        print("  %s %-32s must NOT surface %s %s" % ("PASS " if ok else "FAIL ", q[:32], dt, did))
        if not ok:
            fails.append(q)

    print()
    if fails:
        print("FAILED: " + "; ".join(fails))
        return 1
    print("Ask FlyRegs typo tolerance holds, and nothing correct regressed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
