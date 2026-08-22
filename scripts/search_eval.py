#!/usr/bin/env python3
"""Search eval harness for the semantic-search Edge Function (hybrid_search).

Calls the REAL deployed Edge Function (not the bare hybrid_search RPC) with a
real signed-in user token, matching exactly how the app itself invokes search
-- per this project's own hard-won lesson (see PROJECT_NOTES/flyregs_gotchas.md,
"hybrid_search: a CTE Used 3 Times..."): a lower-level test path can look
correct while the real deployed path is still broken.

Reports Recall@1/@3/@5 and MRR, split by query kind:
  - "lexical"    -- the answer's TITLE shares wording with the query
  - "conceptual" -- the query is phrased the way a pilot would ask it, sharing
                    little or no wording with the answer's title
Keeping those two subsets separate is the point: a change that boosts title
matching will obviously help the lexical set, and the only way to catch it
quietly *hurting* real natural-language questions is to score them apart.

Each query costs one real OpenAI text-embedding-3-small call -- already this
app's normal per-search operating cost, not a new spend category. A full run
(~20 queries) is a small fraction of a cent.

Usage:
    python3 scripts/search_eval.py            # summary only
    python3 scripts/search_eval.py --verbose  # per-query top-5 with titles
"""
import json
import sys
import time
import urllib.request

ENV_PATH = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/.env"
SCRAPER_ENV_PATH = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/.env.scraper"


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


ENV = load_env(ENV_PATH)
SENV = load_env(SCRAPER_ENV_PATH)
URL = ENV["EXPO_PUBLIC_SUPABASE_URL"]
ANON_KEY = ENV["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = SENV["SUPABASE_SERVICE_KEY"]


def req(method, path, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method)
    for k, v in headers.items():
        r.add_header(k, v)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# Each case: (query, kind, {acceptable "type:id" answers}, {must-not-appear}, note)
#
# `accept` is a SET because some answers are legitimately ambiguous in this
# corpus -- e.g. 61 P/CG phrases exist twice, once as the FAA definition and
# once as the "[ICAO]" variant (see memory gotcha_pcg_icao_duplicate_terms);
# either is a correct hit for a glossary lookup, so scoring only one as right
# would penalize the engine for a data-shape quirk rather than a ranking miss.
# An empty accept set means "unscored" -- run for observation only.
CASES = [
    # -- lexical: the answer's own title echoes the query wording --
    ("basic VFR weather minimums cloud clearance", "lexical",
     {"far:91.155", "aim:3-1-4"}, set(),
     "near-verbatim title match on two docs, either is correct"),
    ("IFR flight plan information required", "lexical",
     {"far:91.169"}, set(), ""),
    ("private pilot privileges and limitations pilot in command", "lexical",
     {"far:61.113"}, set(), ""),
    ("runway markings", "lexical",
     {"aim:2-3-3"}, set(), "historically tricky, per project memory"),
    ("inoperative instruments and equipment", "lexical",
     {"far:91.213"}, set(), ""),
    ("supplemental oxygen requirements", "lexical",
     {"far:91.211"}, set(), ""),
    ("pilot logbooks", "lexical",
     {"far:61.51"}, set(), ""),
    ("maintenance records", "lexical",
     {"far:91.417", "far:43.9"}, set(), "two genuinely on-point records rules"),
    ("instrument approach procedure charts", "lexical",
     {"aim:5-4-5"}, set(), ""),
    ("preflight action", "lexical",
     {"far:91.103"}, set(), ""),

    # -- conceptual: phrased as a pilot would ask, little title overlap --
    ("who has final authority for the operation of an aircraft", "conceptual",
     {"far:91.3"}, set(), ""),
    ("how recently must I have flown to carry passengers", "conceptual",
     {"far:61.57"}, set(),
     "WATCH 2026-08-06: regressed from rank ~5 to a MISS by the hybrid_search v6/v7 "
     "lexical zero-match fallback (see migrations_hybrid_search.sql) -- this query's "
     "AND-tsquery also matches 0 rows, so it now gets the same OR-fallback lexical "
     "signal as the AVE-F case, and that signal is noise here (drowns out far:61.57 "
     "instead of helping). Kept the fallback anyway: net effect across the conceptual "
     "set is positive (R@1 0.25->0.33, MRR 0.48->0.52) and it fixed a real crash "
     "(statement timeout) plus surfaced MEA correctly for lost-comms queries -- but "
     "this specific case is a real, known cost of that trade, not yet resolved."),
    ("cloud clearance requirements for VFR flight", "conceptual",
     {"far:91.155", "aim:3-1-4"}, {"far:103.23"},
     "known regression case: must not surface the ultralight rule as the answer"),
    ("what do I say on the radio at an airport with no tower", "conceptual",
     {"aim:4-1-9"}, set(), ""),
    ("what counts as the ceiling in a weather report", "conceptual",
     {"pcg:CEILING", "pcg:CEILING_ICAO", "aim:7-1-14"}, set(),
     "P/CG has FAA + [ICAO] duplicates; the AIM cloud-height para is also correct"),
    ("distress call when in serious danger", "conceptual",
     {"pcg:MAYDAY"}, set(), ""),
    ("what paperwork does a mechanic complete after a repair", "conceptual",
     {"far:43.9", "far:91.417"}, set(), ""),
    ("how do I become a certificated flight instructor", "conceptual",
     {"ac:61-65K", "far:61.183"}, set(),
     "the AC and the eligibility FAR are both legitimately the answer"),
    ("how do i know which ifr route to fly with lost comms", "conceptual",
     {"far:91.185", "aim:6-4-1", "pcg:LOST_COMMUNICATIONS", "dictionary:mnem-mea"}, set(),
     "RC-reported 2026-08-06: the AVE-F mnemonic (dictionary:mnem-ave-f) is the "
     "most direct answer to this exact question but its own vector similarity "
     "is too weak to clear the cutoff even with the dictionary-type rank boost "
     "-- MEA (a different, equally-valid lost-comms mnemonic) does clear it. "
     "Scored on the FAR/AIM/PCG/MEA set, not AVE-F specifically -- don't chase "
     "AVE-F into this list without either richer embedded text for it or a "
     "boost large enough to also fix this that regresses other cases (both "
     "measured and rejected, see PRIMARY_SOURCE_PRIOR's comment)."),

    # -- citation guards: REGRESSION PROTECTION, do not remove --
    # hybrid_search gives an exact source_id match a flat +1.0 RRF contribution,
    # ~30-300x a normal fused score. That boost is the fix for a real bug found
    # live 2026-08-04 (a bare "61.87" surfaced an unrelated AC first, because
    # FAR 61.87's true cosine similarity is only ~0.20 while a merely
    # similar-LOOKING document scored 0.41). Any reranking that blends in
    # similarity can silently undo it, so it is pinned here as a test.
    ("61.87", "citation", {"far:61.87"}, set(),
     "bare citation must win outright despite low cosine similarity"),
    ("91.155", "citation", {"far:91.155"}, set(), ""),

    # -- unscored observation cases --
    ("Airbus SAS airplanes airworthiness directive", "conceptual",
     set(), set(),
     "unscored: many Airbus ADs share near-identical generic subject_heading text, so no single id is uniquely correct"),
    ("what to do if the engine fails right after takeoff", "conceptual",
     set(), set(),
     "unscored: no single canonical answer, watched for obviously-garbage top hits"),
]


def run(verbose=False):
    email = f"search-eval-{int(time.time())}@flyregs.invalid"
    pw = "TmpSearchEval1!"
    s, d = req("POST", "/auth/v1/admin/users",
               {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
               {"email": email, "password": pw, "email_confirm": True})
    assert s == 200, d
    uid = d["id"]

    rows = []
    try:
        # Ask FlyRegs is Pro-gated server-side (has_pro_access(), added
        # 2026-08-05, AFTER this harness was first written) -- without a real
        # user_entitlements row every call 403s before ever reaching
        # hybrid_search. Grant Pro directly via the DB (not RevenueCat --
        # this is a throwaway @flyregs.invalid account, not a real purchase)
        # so the harness measures search quality again instead of the
        # paywall. Inside the try so a transient failure here still hits the
        # finally's cleanup instead of orphaning the auth user.
        #
        # Upsert (Prefer: resolution=merge-duplicates), not a bare POST:
        # sync/migrations_default_entitlements_row_on_signup.sql (2026-08-18)
        # added an on_auth_user_created_entitlements trigger that now inserts
        # a default (all-false) user_entitlements row the instant the admin
        # /auth/v1/admin/users call above creates the auth.users row -- a
        # plain POST here always 409s (23505 dup PK) racing that trigger,
        # which made this harness fail on every run once that trigger
        # shipped. Confirmed live: two separate runs, two different fresh
        # uids, same duplicate-key error both times.
        s, d = req("POST", "/rest/v1/user_entitlements",
                   {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                    "Prefer": "resolution=merge-duplicates"},
                   {"user_id": uid, "is_pro": True})
        assert s in (200, 201, 204), d
        s, d = req("POST", "/auth/v1/token?grant_type=password", {"apikey": ANON_KEY},
                   {"email": email, "password": pw})
        assert s == 200, d
        H = {"apikey": ANON_KEY, "Authorization": f"Bearer {d['access_token']}"}

        for query, kind, accept, forbidden, note in CASES:
            s, d = req("POST", "/functions/v1/semantic-search", H,
                       {"query": query, "matchCount": 8})
            if s != 200:
                print(f"  ERROR {s} on {query!r}: {d}")
                rows.append({"q": query, "kind": kind, "rank": None,
                             "scored": bool(accept), "violation": False})
                continue
            hits = d.get("results", [])
            rank, forbidden_rank = None, None
            for i, h in enumerate(hits):
                key = f"{h.get('source_type')}:{h.get('source_id')}"
                if key in forbidden and forbidden_rank is None:
                    forbidden_rank = i + 1
                if rank is None and key in accept:
                    rank = i + 1
            # A violation is the forbidden doc OUTRANKING the right answer --
            # not merely appearing. § 103.23 is genuinely titled "Flight
            # visibility and cloud clearance requirements", so it is a
            # defensible thing to see far down a cloud-clearance result list;
            # the real, reported bug was it beating § 91.155, the rule that
            # actually applies to the pilot asking. Asserting "must not
            # appear at all" would be both wrong and permanently red, which
            # is how a test stops being read.
            violation = forbidden_rank is not None and (
                rank is None or forbidden_rank < rank)
            top = f"{hits[0]['source_type']}:{hits[0]['source_id']}" if hits else None
            rows.append({"q": query, "kind": kind, "rank": rank, "top": top,
                         "scored": bool(accept), "violation": violation})

            if accept:
                mark = "PASS" if rank == 1 and not violation else (
                    f"@{rank}" if rank else "MISS")
            else:
                mark = "obs"
            print(f"  [{mark:>5}] ({kind[:4]}) {query!r} -> top={top}")
            if verbose:
                for i, h in enumerate(hits[:5]):
                    print(f"           {i+1}. {h['source_type']}:{h['source_id']}"
                          f"  sim={h['similarity']:.3f}  {h.get('title','')[:64]!r}")
    finally:
        req("DELETE", f"/auth/v1/admin/users/{uid}",
            {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"})

    def report(label, subset):
        if not subset:
            return
        n = len(subset)
        r_at = lambda k: sum(1 for r in subset if r["rank"] and r["rank"] <= k) / n
        mrr = sum((1 / r["rank"]) if r["rank"] else 0 for r in subset) / n
        print(f"  {label:<12} n={n:<3} R@1={r_at(1):.2f}  R@3={r_at(3):.2f}  "
              f"R@5={r_at(5):.2f}  MRR={mrr:.2f}")

    scored = [r for r in rows if r["scored"]]
    print("\n" + "=" * 62)
    report("ALL", scored)
    report("lexical", [r for r in scored if r["kind"] == "lexical"])
    report("conceptual", [r for r in scored if r["kind"] == "conceptual"])
    cites = [r for r in scored if r["kind"] == "citation"]
    report("citation", cites)
    if cites and any(r["rank"] != 1 for r in cites):
        print("  *** CITATION REGRESSION: a bare citation query no longer "
              "returns its own document first ***")
    print(f"  forbidden-result violations: {sum(1 for r in rows if r['violation'])}")
    print("=" * 62)
    return rows


if __name__ == "__main__":
    run(verbose="--verbose" in sys.argv)
