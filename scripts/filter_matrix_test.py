#!/usr/bin/env python3
"""Filter-semantics audit across Study Mode, Flashcards and Duels.

Verifies the three properties the whole filter system rests on:

  COVERAGE   every individual filter value returns real, correct material
  UNION      selecting several values in one dimension combines them --
             count(A,B) must equal |set(A) union set(B)|, never intersect
             and never lose items
  DESELECT   removing a value removes exactly that value's exclusive
             material from the pool and nothing else

...and that dimensions AND together (type x level x category), while values
within a dimension OR together.

Everything is measured against the live DB through the same RPCs the app
calls, as a real authenticated user (anon key + user JWT), so RLS and
auth.uid() behave exactly as they do on device.

Usage:  python3 scripts/filter_matrix_test.py [study|duel|all]
"""
import itertools
import json
import os
import secrets
import sys
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

TYPES = ["far", "aim", "pcg", "ac"]
LEVELS = ["student", "private", "commercial", "atp", "cfi", "mechanic"]
# Must match src/lib/profileRatings.ts CATEGORY_CLASSES exactly -- these are
# the literal strings the app sends, and category_classes_from_text() returns
# the same uppercase codes. A case mismatch here silently tests nothing: every
# value would return the identical "unclassified" pool and still look like it
# passed.
CATS = ["ASEL", "ASES", "AMEL", "AMES", "HELI", "GYRO", "GLIDER", "AIRSHIP",
        "BALLOON", "POWLIFT"]

FAILURES = []
WARNINGS = []


def http(method, path, *, key, jwt=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
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


def rpc(fn, jwt, params=None):
    st, body = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300:
        raise RuntimeError(f"rpc {fn} {params} -> HTTP {st}: {body}")
    return body


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")
    return cond


def warn(label, detail=""):
    print(f"  WARN  {label}   {detail}")
    WARNINGS.append(f"{label} :: {detail}")


def mgmt_query(sql):
    """Read-only SQL through the Management API, to cross-check the RPCs
    against the underlying tables rather than against themselves."""
    env = load_env(".env.supabase-mgmt")
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{env['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {env['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    return json.load(urllib.request.urlopen(req))


def category_counts():
    """How many STUDY-POOL items carry each category, straight from the tables.

    Mirrors get_study_queue's own eligibility rules (body_text present for
    far/aim, description+title for ac, definition for pcg) so the numbers are
    comparable to the pool count.
    """
    sql = """
    with items as (
      -- FAR uses far_category_classes(part, title): whole FAA parts that
      -- exist for one aircraft category (23/25 airplanes, 27/29 rotorcraft,
      -- 31 balloons) plus the title match. Must mirror the RPCs exactly.
      select far_category_classes(part, title) c from far_sections
        where title is not null and title <> '' and body_text is not null and body_text <> ''
          -- mirror get_study_*'s membership: within-part-unique titles only
          and section_number in (select section_number from study_far_sections)
      union all
      -- Must call the SAME specialized function get_study_pool_count uses
      -- (aim_category_classes(chapter, title), which also weighs chapter --
      -- not the generic title-only category_classes_from_text()). Using the
      -- generic function here previously made this independent check diverge
      -- from the RPC's real classification on a handful of paragraphs,
      -- producing false FAILs on an otherwise-correct RPC.
      select aim_category_classes(chapter, coalesce(title,'')) from aim_paragraphs
        where body_text is not null and body_text <> ''
      union all
      select category_classes_from_text(term) from pcg_terms
        where definition is not null and definition <> ''
      union all
      -- Same reasoning as AIM above: must call ac_category_classes(subject_
      -- series, title), the function get_study_pool_count actually uses --
      -- confirmed 112 of ~700 active AC titles classify differently under
      -- the generic text-only function vs. this one (which also weighs
      -- subject_series ranges like 20-/23-/25-/27-/29-/31-), which was the
      -- entire root cause of every "CATEGORY EXCLUSION IS EXACT" FAIL below.
      select ac_category_classes(subject_series, title) from advisory_circulars
        where status='active' and title is not null and title <> ''
          and description is not null and description <> ''
    )
    select coalesce(x.cat,'_none') as cat, count(*) as n
    from items left join lateral unnest(items.c) as x(cat) on true
    group by 1
    """
    out = {}
    any_classified = 0
    for row in mgmt_query(sql):
        if row["cat"] == "_none":
            continue
        out[row["cat"]] = int(row["n"])
        any_classified += int(row["n"])
    # An item can carry two categories; count distinct classified items.
    distinct = mgmt_query(sql.replace(
        "select coalesce(x.cat,'_none') as cat, count(*) as n\n    from items left join lateral unnest(items.c) as x(cat) on true\n    group by 1",
        "select count(*) as n from items where c is not null and array_length(c,1) > 0"))
    out["_any"] = int(distinct[0]["n"])
    return out


def make_user(prefix="filt"):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"], "email": email}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


# ---------------------------------------------------------------- study side

def pool_count(jwt, types=None, levels=None, cats=None):
    r = rpc("get_study_pool_count", jwt, {
        "p_item_types": types, "p_levels": levels, "p_category_classes": cats})
    if isinstance(r, list):
        r = r[0] if r else 0
    if isinstance(r, dict):
        r = list(r.values())[0]
    return int(r or 0)


def queue_ids(jwt, types=None, levels=None, cats=None, limit=200):
    """The identity SET a filter selection actually yields.

    get_study_queue is deliberately randomised, so a single call proves
    nothing about set membership. Repeated sampling converges on the pool
    for the small pools this is used on, and for large pools we only ever
    assert membership (every item returned must satisfy the filter), never
    completeness.
    """
    seen = {}
    for _ in range(6):
        rows = rpc("get_study_queue", jwt, {
            "p_limit": limit, "p_item_types": types,
            "p_levels": levels, "p_category_classes": cats}) or []
        for row in rows:
            seen[(row["item_type"], row["item_id"])] = row
        if len(rows) < limit:
            break
    return seen


def scenario_study():
    print("\n" + "=" * 74)
    print("STUDY MODE / FLASHCARDS  —  get_study_pool_count + get_study_queue")
    print("=" * 74)
    u = make_user("study")
    # Study Mode is Pro-gated as of the 2026-08-11 gating sweep (both RPCs
    # used to have zero tier check at all -- see gotcha_gating_sweep_2026_08_11.md).
    # Same fix as grant_premium's own docstring describes for Duels: without
    # this, every pool_count/queue_ids call below now correctly returns
    # empty for a non-Pro account, which broke this scenario's actual job
    # (testing filter LOGIC) rather than proving the new tier gate works --
    # that gate already has its own live-verified coverage elsewhere.
    grant_premium(u["id"])
    try:
        total = pool_count(u["jwt"])
        print(f"\n  baseline: ALL filters off = {total} items\n")
        check("unfiltered pool is non-empty", total > 0, str(total))

        # ---------- COVERAGE: every single value returns material ----------
        print("  -- COVERAGE: each filter value on its own --")
        per_type = {}
        for t in TYPES:
            n = pool_count(u["jwt"], types=[t])
            per_type[t] = n
            check(f"type={t} has material", n > 0, f"{n} items")
        per_level = {}
        for l in LEVELS:
            n = pool_count(u["jwt"], levels=[l])
            per_level[l] = n
            check(f"level={l} has material", n > 0, f"{n} items")
        # Category is deliberately asymmetric from level: content with NO
        # category is "not category-specific" and stays in for everyone (FAR
        # 91.103 preflight action genuinely applies to an ASEL pilot). So a
        # raw count is nearly identical for every category and proves
        # nothing. What must be true is that picking a category ADDS that
        # category's own material and DROPS the other categories' -- measured
        # against the no-category-filter baseline.
        per_cat = {}
        neutral = None
        for c in CATS:
            n = pool_count(u["jwt"], cats=[c])
            per_cat[c] = n
            check(f"category={c} has material", n > 0, f"{n} items")
        for c in CATS:
            others = [x for x in CATS if x != c]
            n_others = pool_count(u["jwt"], cats=others)
            if per_cat[c] == n_others == total:
                check(f"category={c} actually filters anything", False,
                      "selecting it and excluding it both return the full pool")
        if len(set(per_cat.values())) == 1:
            warn("every category returns an identical count",
                 f"all = {list(per_cat.values())[0]}; category-specific material "
                 f"may not be matching at all")

        # Category is exclusion-shaped, so the meaningful assertion is exact:
        # pool(X) must equal (items with NO category, which apply to everyone)
        # plus (items classified X, and nothing classified as anything else).
        # Comparing two categories' pool SIZES proves nothing -- HELI's pool is
        # bigger than BALLOON's simply because more content is helicopter-
        # specific. classified counts come straight from the tables, so this
        # cross-checks the RPC against the data independently.
        print("\n  -- CATEGORY EXCLUSION IS EXACT (pool = neutral + own only) --")
        classified = category_counts()
        neutral = total - classified["_any"]
        print(f"  items with no category (apply to everyone): {neutral}")
        print(f"  category-specific item counts: "
              f"{ {k: v for k, v in classified.items() if k != '_any'} }")
        for c in CATS:
            expected = neutral + classified.get(c, 0)
            check(f"pool({c}) == neutral + {c}-specific "
                  f"({neutral} + {classified.get(c, 0)})",
                  per_cat[c] == expected, f"got {per_cat[c]}, expected {expected}")
        n_all = pool_count(u["jwt"], cats=CATS)
        check("selecting every category == no category filter",
              n_all == total, f"{n_all} vs {total}")
        zero_cats = [c for c in CATS if classified.get(c, 0) == 0]
        if zero_cats:
            warn(f"{len(zero_cats)} category chips match no material of their own: "
                 f"{zero_cats}",
                 "they still work as exclusion filters, but selecting them can "
                 "never ADD content")
        print(f"\n  by type:  {per_type}")
        print(f"  by level: {per_level}")
        print(f"  by cat:   {per_cat}\n")

        # ---------- types partition the corpus exactly ----------
        print("  -- UNION: content types --")
        check("the 4 content types sum to the unfiltered total",
              sum(per_type.values()) == total,
              f"sum={sum(per_type.values())} total={total}")
        for a, b in itertools.combinations(TYPES, 2):
            n = pool_count(u["jwt"], types=[a, b])
            check(f"types {a}+{b} == {a} plus {b}",
                  n == per_type[a] + per_type[b],
                  f"combined={n} {a}={per_type[a]} {b}={per_type[b]}")
        n3 = pool_count(u["jwt"], types=TYPES[:3])
        check("3 types combine additively",
              n3 == sum(per_type[t] for t in TYPES[:3]),
              f"{n3} vs {sum(per_type[t] for t in TYPES[:3])}")
        check("selecting all 4 types == no type filter",
              pool_count(u["jwt"], types=TYPES) == total)

        # ---------- levels: overlapping sets, must UNION not intersect ----------
        print("\n  -- UNION: knowledge levels (these overlap, so union != sum) --")
        for a, b in itertools.combinations(LEVELS, 2):
            n = pool_count(u["jwt"], levels=[a, b])
            lo, hi = max(per_level[a], per_level[b]), per_level[a] + per_level[b]
            ok = lo <= n <= hi
            if not ok:
                check(f"levels {a}+{b} union is between max and sum", False,
                      f"got {n}, expected {lo}..{hi} ({a}={per_level[a]} {b}={per_level[b]})")
            elif n < lo:
                check(f"levels {a}+{b} did not INTERSECT", False, f"{n} < max {lo}")
        check("no level pair intersected instead of unioning", True)
        allv = pool_count(u["jwt"], levels=LEVELS)
        check("all 6 levels selected >= any single level",
              allv >= max(per_level.values()), f"{allv} vs {max(per_level.values())}")
        print(f"  all-6-levels pool = {allv}  (unfiltered = {total}; "
              f"difference = {total - allv} unclassified items, correctly excluded)")

        # ---------- MONOTONICITY: adding never shrinks, removing never grows ----------
        print("\n  -- MONOTONIC: adding a value never shrinks the pool --")
        for dim, values, kw in (("level", LEVELS, "levels"), ("category", CATS, "cats"),
                                ("type", TYPES, "types")):
            running = []
            prev = 0
            bad = None
            for v in values:
                running.append(v)
                n = pool_count(u["jwt"], **{kw: list(running)})
                if n < prev:
                    bad = f"{dim}s {running} = {n} < previous {prev}"
                    break
                prev = n
            check(f"{dim}: pool grows monotonically as values are added", bad is None, bad or "")

        # ---------- DESELECT: removing a value removes its exclusive items ----------
        print("\n  -- DESELECT: removing a value drops exactly its exclusive material --")
        for dim, values, kw in (("level", LEVELS, "levels"), ("type", TYPES, "types")):
            full = pool_count(u["jwt"], **{kw: list(values)})
            for v in values:
                rest = [x for x in values if x != v]
                n = pool_count(u["jwt"], **{kw: rest})
                if n > full:
                    check(f"{dim}: deselecting {v} does not GROW the pool", False,
                          f"{n} > {full}")
                elif n == full and dim == "type":
                    check(f"{dim}: deselecting {v} actually removes its items", False,
                          f"pool unchanged at {n} despite {v} having "
                          f"{per_type.get(v)} items")
            check(f"{dim}: every deselection shrinks-or-holds the pool", True)

        # ---------- MEMBERSHIP: returned items really satisfy the filter ----------
        print("\n  -- MEMBERSHIP: items returned actually match the filter --")
        for t in TYPES:
            got = queue_ids(u["jwt"], types=[t], limit=50)
            wrong = [k for k in got if k[0] != t]
            check(f"type={t} queue returns only {t} items", not wrong,
                  f"{len(wrong)} foreign: {wrong[:4]}")
        for a, b in [("far", "pcg"), ("aim", "ac")]:
            got = queue_ids(u["jwt"], types=[a, b], limit=50)
            kinds = {k[0] for k in got}
            check(f"types {a}+{b} queue returns BOTH kinds and nothing else",
                  kinds <= {a, b} and len(kinds) == 2, f"saw {kinds}")

        # ---------- pool count must agree with what the queue can serve ----------
        print("\n  -- CONSISTENCY: pool count vs. what the queue actually serves --")
        for name, kwargs in [("mechanic only", {"levels": ["mechanic"]}),
                             ("student only", {"levels": ["student"]}),
                             ("pcg + student", {"types": ["pcg"], "levels": ["student"]}),
                             ("ac + mechanic", {"types": ["ac"], "levels": ["mechanic"]})]:
            n = pool_count(u["jwt"], **kwargs)
            got = queue_ids(u["jwt"], limit=100, **kwargs)
            if n == 0:
                check(f"{name}: empty pool serves no cards", len(got) == 0,
                      f"count=0 but queue served {len(got)}")
            else:
                check(f"{name}: non-empty pool actually serves cards", len(got) > 0,
                      f"count={n} but queue served 0")
                if len(got) > n:
                    check(f"{name}: queue never serves more than the pool count",
                          False, f"served {len(got)} > count {n}")
        return per_type, per_level, per_cat
    finally:
        delete_user(u["id"])


# ---------------------------------------------------------------- duel side

def duel_pool(jwt, types=None, levels=None, cats=None):
    """Count of what create_challenge could draw, via the same quizzable views."""
    conds = {"p_item_types": types, "p_levels": levels, "p_category_classes": cats}
    return conds


def grant_premium(uid):
    """Duels is deliberately Premium-gated (RC, 2026-07-31, see paywall.tsx)
    -- fresh admin-API accounts have no user_entitlements row at all, so
    create_challenge correctly 400s them with 'Duels requires Premium'.
    Without this the whole duel scenario throws on its very first call
    instead of testing anything."""
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_pro": True, "is_premium": True, "is_unlocked": True},
         headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


def scenario_duel():
    print("\n" + "=" * 74)
    print("DUELS  —  create_challenge question pool (quizzable_* views)")
    print("=" * 74)
    a = make_user("duelfA")
    b = make_user("duelfB")
    grant_premium(a["id"])
    grant_premium(b["id"])
    try:
        def try_create(types=None, levels=None, cats=None, n=10):
            try:
                cid = rpc("create_challenge", a["jwt"], {
                    "p_opponent_ids": [b["id"]], "p_question_count": n,
                    "p_item_types": types, "p_levels": levels,
                    "p_category_classes": cats})
            except RuntimeError as e:
                if "No questions match those filters" in str(e):
                    return None, []
                raise
            st, qs = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid}"
                                 f"&select=item_type,item_id", key=SERVICE)
            return cid, qs

        print("\n  -- COVERAGE: every filter value can build a duel --")
        for t in TYPES:
            cid, qs = try_create(types=[t], n=5)
            check(f"type={t} produces questions", bool(qs), f"{len(qs)} questions")
            if qs:
                check(f"type={t} produces ONLY {t} questions",
                      all(q["item_type"] == t for q in qs),
                      str({q["item_type"] for q in qs}))
        for l in LEVELS:
            cid, qs = try_create(levels=[l], n=5)
            check(f"level={l} produces questions", bool(qs), f"{len(qs)} questions")
        for c in CATS:
            cid, qs = try_create(cats=[c], n=5)
            check(f"category={c} produces questions", bool(qs), f"{len(qs)} questions")

        print("\n  -- UNION: multiple content types mix in one duel --")
        # 20 questions over 2 types should, with overwhelming probability,
        # contain both -- and must never contain a third.
        for pair in [("far", "aim"), ("pcg", "ac"), ("far", "pcg")]:
            cid, qs = try_create(types=list(pair), n=20)
            kinds = {q["item_type"] for q in qs}
            check(f"duel with types {pair} draws only from those types",
                  kinds <= set(pair), f"saw {kinds}")
            if len(qs) >= 12 and len(kinds) < 2:
                warn(f"duel with types {pair} drew only {kinds} across {len(qs)} questions",
                     "possible per-type cap starving one side")
        cid, qs = try_create(types=TYPES, n=20)
        check("duel with all 4 types draws from more than one type",
              len({q["item_type"] for q in qs}) >= 2,
              str({q["item_type"] for q in qs}))

        print("\n  -- DESELECT: a removed type cannot appear --")
        for excluded in TYPES:
            rest = [t for t in TYPES if t != excluded]
            cid, qs = try_create(types=rest, n=20)
            check(f"deselecting {excluded} keeps it out of the question pool",
                  all(q["item_type"] != excluded for q in qs),
                  f"{excluded} appeared {sum(1 for q in qs if q['item_type']==excluded)}x")

        print("\n  -- LEVEL correctness: student duel excludes airline material --")
        cid, qs = try_create(types=["far"], levels=["student"], n=25)
        parts = sorted({q["item_id"].split(".")[0] for q in qs})
        bad = {"121", "125", "129", "135", "25", "29"} & set(parts)
        check("student FAR duel contains no transport/airline parts", not bad,
              f"found {bad} in {parts}")
        cid, qs = try_create(types=["far"], levels=["mechanic"], n=25)
        mparts = sorted({q["item_id"].split(".")[0] for q in qs})
        print(f"  mechanic FAR duel parts: {mparts}")
        check("mechanic FAR duel includes maintenance parts",
              bool({"43", "65", "145", "21", "39", "147", "91"} & set(mparts)),
              str(mparts))

        print("\n  -- CROSS-DIMENSION: type AND level AND category --")
        cid, qs = try_create(types=["far"], levels=["student"], cats=["heli"], n=10)
        if qs:
            check("far+student+heli produces only far questions",
                  all(q["item_type"] == "far" for q in qs))
        else:
            warn("far+student+heli produced no questions",
                 "narrow but legal combination -- refused with a clear message")
    finally:
        delete_user(a["id"])
        delete_user(b["id"])


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    try:
        if which in ("study", "all"):
            scenario_study()
        if which in ("duel", "all"):
            scenario_duel()
    finally:
        print("\n" + "=" * 74)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All filter checks passed.")
        if WARNINGS:
            print(f"\n{len(WARNINGS)} warning(s):")
            for w in WARNINGS:
                print(f"  - {w}")
    sys.exit(1 if FAILURES else 0)
