#!/usr/bin/env python3
"""Breadth test for the real deployed semantic-search Edge Function
("Ask FlyRegs"). Calls it as a real authenticated user (disposable
@flyregs.invalid account, matching the established e2e-test pattern),
across a genuinely diverse battery of questions spanning all 6 source
types and several phrasing styles -- companion to smartsearch_bench.py /
smartsearch_breadth.py, but for the embedding-based system instead of
SmartSearch's lexical one.

Usage:  python3 scripts/semantic_search_breadth_test.py
"""
import json
import os
import secrets
import time
import urllib.error
import urllib.request

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
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]


def http(method, path, *, key, jwt=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"]}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


# (query, category, expected source_type hint or None)
QUERIES = [
    # FAR -- direct regulatory
    ("What's the minimum safe altitude over a congested area?", "far", "far"),
    ("Can I fly a Cessna 172 without a current annual inspection?", "far", "far"),
    ("How many hours of night flying do I need for a private pilot certificate?", "far", "far"),
    # AIM -- procedures/phraseology
    ("What does 'cleared for the option' mean?", "aim", "aim"),
    ("How do wake turbulence categories work for spacing behind a heavy jet?", "aim", "aim"),
    ("What's the phraseology for reporting a runway incursion?", "aim", "aim"),
    # P/CG -- glossary/definitional
    ("What is a hold-short line?", "pcg", "pcg"),
    ("Define positive control airspace", "pcg", "pcg"),
    # AC -- guidance/best-practice
    ("What guidance exists on installing airborne collision avoidance systems?", "ac", "ac"),
    ("How should I document weight and balance changes after installing new avionics?", "ac", "ac"),
    ("What's the FAA's guidance on drone operations over people?", "ac", None),
    # AD -- airworthiness, harder since these are model-specific, not general knowledge
    ("Are there any airworthiness directives about Lycoming engine crankshafts?", "ad", "ad"),
    ("What ADs exist for Cessna 172 seat rails?", "ad", "ad"),
    # LOI -- interpretive/legal nuance
    ("Can a flight instructor charge for ground instruction without holding a commercial certificate?", "loi", None),
    ("What counts as 'compensation or hire' for a private pilot?", "loi", None),
    # Everyday/non-technical phrasing (breadth, matches smartsearch_breadth.py style)
    ("can I fly drunk", "everyday", "far"),
    ("do I need to file a flight plan for a cross country", "everyday", "far"),
    ("what happens if my radio dies in the clouds", "everyday", "far"),
    ("how close can I fly to a stadium during a game", "everyday", None),
    # Multi-concept / harder synthesis questions
    ("What's the difference between MEA and MOCA and when would I use each?", "multi", None),
    ("If I'm on an IFR flight plan and lose my transponder, what do I do?", "multi", "far"),
    # Deliberately obscure/niche
    ("What are the requirements for towing a glider?", "niche", "far"),
    ("What's the regulation on dropping objects from an aircraft?", "niche", "far"),
    ("What is a NOTAM and who issues them?", "niche", "pcg"),
    # Out-of-scope (should fail gracefully, not hallucinate a match)
    ("What's the best restaurant near KJFK?", "out-of-scope", None),
]


def main():
    user = make_user("askflyregs")
    try:
        print(f"Testing {len(QUERIES)} queries against real deployed semantic-search...\n")
        for query, category, hint in QUERIES:
            st, body = http("POST", "/functions/v1/semantic-search", key=ANON, jwt=user["jwt"],
                            body={"query": query, "matchCount": 5})
            print(f"[{category:12s}] {query}")
            if st != 200 or not isinstance(body, dict) or "results" not in body:
                print(f"    !! FAILED: HTTP {st} {body}")
                print()
                continue
            results = body["results"]
            if not results:
                print("    (no results)")
            for r in results[:3]:
                sim = r.get("similarity", 0)
                print(f"    {sim:.3f}  {r['source_type']:4s}  {r.get('title', '')[:80]}")
            if hint and results and results[0]["source_type"] != hint:
                print(f"    ~~ top result type ({results[0]['source_type']}) != expected hint ({hint})")
            print()
    finally:
        delete_user(user["id"])


if __name__ == "__main__":
    main()
