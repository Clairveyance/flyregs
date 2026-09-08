#!/usr/bin/env python3
"""End-to-end test of the Study-Mode TOPIC filter, as a REAL signed-in user.

get_study_queue and friends are SECURITY DEFINER and scoped to auth.uid(), so
calling them with the service key returns 0 for everything and proves nothing.
This mints a real session for a disposable @flyregs.invalid account and calls
the RPCs exactly the way the app does -- named arguments over PostgREST.

Checks, in order of what would actually hurt:
  1. NO REGRESSION -- omitting p_topics entirely (what every shipped build
     does) returns the same counts as passing it explicitly as null.
  2. Every topic returns a non-empty pool, so no chip is a dead end.
  3. Topic pools sum sanely and each is smaller than the unfiltered pool.
  4. A topic filter EXCLUDES unclassified corpora (ac/pcg/dictionary).
  5. The queue itself returns cards whose items really carry that topic.
"""
import json, os, sys, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(fn):
    d = {}
    with open(os.path.join(BASE, fn)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if line and not line.startswith("#"):
                k, _, v = line.partition("=")
                d[k] = v.strip().strip('"').strip("'")
    return d


E = load(".env.scraper")
URL, SVC_KEY = E["SUPABASE_URL"], E["SUPABASE_SERVICE_KEY"]
ANON = load(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
SVC = {"apikey": SVC_KEY, "Authorization": "Bearer " + SVC_KEY, "Content-Type": "application/json"}


def call(url, body=None, headers=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {},
                                 method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def session_for(email="tiermatrix-pro@flyregs.invalid"):
    st, link = call(f"{URL}/auth/v1/admin/generate_link",
                    {"type": "magiclink", "email": email}, SVC)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    st, sess = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                    {"apikey": ANON, "Content-Type": "application/json"})
    return sess["access_token"]


def main():
    tok = session_for()
    H = {"apikey": ANON, "Authorization": "Bearer " + tok, "Content-Type": "application/json"}

    def rpc(fn, args):
        st, d = call(f"{URL}/rest/v1/rpc/{fn}", args, H)
        if st != 200:
            raise SystemExit(f"FAIL  {fn}{args} -> HTTP {st}: {d}")
        return d

    fails = []
    def check(name, cond, detail=""):
        print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
        if not cond:
            fails.append(name)

    print("=== 1. no regression: a shipped build omits p_topics entirely ===")
    legacy = rpc("get_study_pool_count",
                 {"p_item_types": None, "p_levels": None, "p_category_classes": None})
    explicit = rpc("get_study_pool_count",
                   {"p_item_types": None, "p_levels": None, "p_category_classes": None,
                    "p_topics": None})
    check("4-arg call still resolves (old builds keep working)", isinstance(legacy, int) and legacy > 0,
          f"pool={legacy}")
    check("omitting p_topics == passing null", legacy == explicit, f"{legacy} vs {explicit}")

    lv_legacy = rpc("get_study_pool_counts_by_level", {"p_item_types": None, "p_category_classes": None})
    lv_new = rpc("get_study_pool_counts_by_level",
                 {"p_item_types": None, "p_category_classes": None, "p_topics": None})
    check("counts_by_level unchanged", lv_legacy == lv_new)

    q_legacy = rpc("get_study_queue", {"p_limit": 5, "p_item_types": None, "p_levels": None,
                                       "p_category_classes": None})
    check("get_study_queue 4-arg call still returns cards", len(q_legacy) > 0, f"{len(q_legacy)} cards")

    print()
    print("=== 2. every topic is a live filter, not a dead chip ===")
    topics = [r["topic"] for r in _topics()]
    empty = []
    sizes = {}
    for t in topics:
        n = rpc("get_study_pool_count", {"p_item_types": None, "p_levels": None,
                                         "p_category_classes": None, "p_topics": [t]})
        sizes[t] = n
        if not n:
            empty.append(t)
    for t in sorted(sizes, key=lambda k: -sizes[k]):
        print("      %6d  %s" % (sizes[t], t))
    check("no topic returns an empty pool", not empty, ", ".join(empty) or "all non-empty")
    check("every topic pool is smaller than the unfiltered pool",
          all(v < legacy for v in sizes.values()),
          "max topic pool %d vs unfiltered %d" % (max(sizes.values()), legacy))

    print()
    print("=== 3. a topic filter excludes the unclassified corpora ===")
    for corpus in ("ac", "dictionary", "pcg"):
        n = rpc("get_study_pool_count", {"p_item_types": [corpus], "p_levels": None,
                                         "p_category_classes": None, "p_topics": ["Airspace"]})
        base = rpc("get_study_pool_count", {"p_item_types": [corpus], "p_levels": None,
                                            "p_category_classes": None})
        check(f"{corpus}: topic filter yields 0 (unfiltered {base})", n == 0, f"got {n}")

    print()
    print("=== 4. the queue returns cards that really carry the topic ===")
    for t in ("Airspace", "Medical & Fitness", "Hazardous Materials"):
        cards = rpc("get_study_queue", {"p_limit": 8, "p_item_types": None, "p_levels": None,
                                        "p_category_classes": None, "p_topics": [t]})
        if not cards:
            check(f"queue for {t!r} returns cards", False, "0 cards")
            continue
        bad = [c for c in cards if _topic_of(c["item_type"], c["item_id"]) != t]
        check(f"queue for {t!r}: {len(cards)} cards, all on-topic", not bad,
              "off-topic: " + ", ".join(f"{c['item_type']}:{c['item_id']}" for c in bad[:4]))

    print()
    if fails:
        print("FAILED: " + "; ".join(fails))
        return 1
    print("All study-topic filter checks passed.")
    return 0


def _mgmt(sql):
    sys.path.insert(0, os.path.join(BASE, "scripts"))
    from access_matrix_sweep import mgmt
    return mgmt(sql)


def _topics():
    return _mgmt("select distinct study_topic(item_type, item_id) as topic from study_facts "
                 "where study_topic(item_type, item_id) is not null order by 1")


_TOPIC_CACHE = {}
def _topic_of(item_type, item_id):
    k = (item_type, item_id)
    if k not in _TOPIC_CACHE:
        r = _mgmt("select study_topic(%s, %s) as t"
                  % ("'" + item_type.replace("'", "''") + "'", "'" + item_id.replace("'", "''") + "'"))
        _TOPIC_CACHE[k] = r[0]["t"]
    return _TOPIC_CACHE[k]


if __name__ == "__main__":
    sys.exit(main())
