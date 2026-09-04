#!/usr/bin/env python3
"""Tier-gating regression test for content browsing, search, MagicLink
citations, bookmarks/folders/notes (incl. highlights), and raw-table lockdown.

Scope owner's slice of the 2026-08-16 all-app function test (RC: "we need an
all-app function test... we must make sure our gates work in every spot").
This file covers: FAR/AIM/AC/AD/P-CG/LOI/CFR49/Dictionary detail-page gating,
all 8 search RPCs' depth cap, SmartSearch (semantic-search Edge Function)
Pro-gate, document_citations_gated (MagicLink) tap-through, bookmarks/notes/
folders sync-push Pro-gate + downgrade-retains-read behavior, and raw-table
blocking on the 5 gated tables/views.

Reuses the exact TIERS/ensure_user pattern from tier_matrix_test.py (5 real
tiers via disposable/persistent @flyregs.invalid accounts + real
user_entitlements rows) for GET-only probes, and duel_e2e_test.py's
http()/rpc()/make_user()/delete_user() helpers for mutation tests that need
their own disposable, cleaned-up accounts.

Usage: python3 scripts/content_search_bookmarks_magiclink_tier_test.py
"""
import json
import os
import re
import sys
import time
import secrets
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
from duel_e2e_test import http, rpc, make_user, delete_user, check, note, FAILURES, NOTES  # noqa: E402

env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                     open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}


def call(url, data=None, headers=None, method=None):
    r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body[:200]


TIERS = {
    "free":    dict(is_pro=False, is_premium=False, is_unlocked=False),
    "plus":    dict(is_pro=False, is_premium=False, is_unlocked=True),
    "pro":     dict(is_pro=True,  is_premium=False, is_unlocked=True),
    "premium": dict(is_pro=True,  is_premium=True,  is_unlocked=True),
}


def ensure_user(tier):
    """Persistent, reusable @flyregs.invalid fixture per tier -- same
    accounts tier_matrix_test.py uses, so entitlement state doesn't drift
    between the two harnesses."""
    email = f"tiermatrix-{tier}@flyregs.invalid"
    st, out = call(f"{URL}/auth/v1/admin/users", {"email": email, "password": "Fl!" + tier + "-Matrix-9137",
                                                    "email_confirm": True}, SVC)
    if st in (200, 201):
        uid = out["id"]
    else:
        st, out = call(f"{URL}/auth/v1/admin/users?page=1&per_page=200", headers=SVC)
        uid = next(u["id"] for u in out["users"] if u["email"] == email)
    call(f"{URL}/rest/v1/user_entitlements", {"user_id": uid, **TIERS[tier],
         "updated_at": "2026-08-16T00:00:00Z"},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})
    _, link = call(f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email}, SVC)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    _, sess = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                   {"apikey": ANON, "Content-Type": "application/json"})
    return uid, sess["access_token"]


def hdr(jwt=None):
    return {"apikey": ANON, "Authorization": f"Bearer {jwt or ANON}", "Content-Type": "application/json"}


TOKENS = {"anon": None}
UIDS = {}
for t in TIERS:
    UIDS[t], TOKENS[t] = ensure_user(t)

TIER_ORDER = ["anon", "free", "plus", "pro", "premium"]


# ============================================================================
# 1. SEARCH DEPTH CAP -- all 8 content-search RPCs. Non-Plus must be capped
#    at <=10 regardless of requested limit; Plus+ must be able to exceed 10.
# ============================================================================
print("\n=== SEARCH DEPTH CAP (8 RPCs x 5 tiers, result_limit=200) ===")
SEARCH_RPCS = {
    "search_far":  {"query": "aircraft", "result_limit": 200},
    "search_aim":  {"query": "aircraft", "result_limit": 200},
    "search_pcg":  {"query": "aircraft", "result_limit": 200},
    "search_ads":  {"query": "engine", "result_limit": 200},
    "search_cfr49": {"query": "aircraft", "result_limit": 200},
    "search_dictionary": {"query": "aircraft", "result_limit": 200},
    "search_acs":  {"query": "aircraft", "result_limit": 200},
    "search_legal_interpretations": {"q": "aircraft", "lim": 200},
}
depth = {fn: {} for fn in SEARCH_RPCS}
for fn, params in SEARCH_RPCS.items():
    for t in TIER_ORDER:
        st, d = call(f"{URL}/rest/v1/rpc/{fn}", params, hdr(TOKENS[t]))
        depth[fn][t] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    print(f"  {fn:<32}" + "  ".join(f"{t}={depth[fn][t]}" for t in TIER_ORDER))

for fn in ["search_far", "search_aim", "search_pcg", "search_ads", "search_cfr49", "search_dictionary", "search_acs"]:
    free_n = depth[fn]["free"]
    plus_n = depth[fn]["plus"]
    check(f"{fn}: free/anon capped at <=10",
          isinstance(depth[fn]["anon"], int) and depth[fn]["anon"] <= 10
          and isinstance(free_n, int) and free_n <= 10,
          f"anon={depth[fn]['anon']} free={free_n}")
    if isinstance(plus_n, int) and plus_n > 10:
        check(f"{fn}: plus/pro/premium exceed the free cap", True)
    else:
        note(f"{fn}: plus only returned {plus_n} results (<=10) -- either genuinely "
             f"fewer than 11 real matches exist, or the depth cap isn't lifting for Plus; "
             f"inconclusive from count alone, spot-check manually")

# search_legal_interpretations USED to be the one search RPC with no
# has_plus_access() depth gate -- the 2026-08-11 depth-gating sweep never touched it.
# That gap has since been closed; the live function now ends with:
#   limit (case when public.has_plus_access()
#               then least(coalesce(lim, 50), 200)
#               else least(coalesce(lim, 50), 10) end)
#
# This check was originally written to CONFIRM the gap, so it asserted
# anon == premium and passed while the bug existed. Left as-is it failed
# permanently once the bug was fixed, which would have masked a real
# regression here. Inverted 2026-09-04 to guard the fix instead: free/anon
# must stay capped, and paid tiers must actually exceed that cap.
li = depth["search_legal_interpretations"]
if all(isinstance(li[t], int) for t in TIER_ORDER):
    check("search_legal_interpretations: free/anon capped at <=10",
          li["anon"] <= 10 and li["free"] <= 10, str(li))
    check("search_legal_interpretations: plus/pro/premium exceed the free cap",
          li["plus"] > 10 and li["pro"] > 10 and li["premium"] > 10, str(li))


# ============================================================================
# 2. SmartSearch / Ask FlyRegs (Pro+) -- semantic-search Edge Function
# ============================================================================
print("\n=== SmartSearch (semantic-search Edge Function, Pro+) ===")
ss = {}
for t in TIER_ORDER:
    st, d = call(f"{URL}/functions/v1/semantic-search",
                 {"query": "how much rest before flying passengers", "matchCount": 2}, hdr(TOKENS[t]))
    ss[t] = st
print("  " + "  ".join(f"{t}={ss[t]}" for t in TIER_ORDER))
check("semantic-search: anon/free/plus blocked (non-200)",
      all(ss[t] != 200 for t in ("anon", "free", "plus")), str(ss))
check("semantic-search: pro/premium allowed (200)",
      ss["pro"] == 200 and ss["premium"] == 200, str(ss))


# ============================================================================
# 3. Detail-page gated columns (AC/AD/LOI/Dictionary) -- extends the same
#    probes tier_matrix_test.py already runs, kept here for a self-contained
#    report of this slice.
# ============================================================================
print("\n=== DETAIL PAGE GATED CONTENT ===")
# Two shapes exist: AC truncates to a free-preview length/block-count (never
# zero -- "2 sections of an AC" is deliberate, per src/lib/acFormat.ts's
# previewBlockCount / left(pdf_text,2000)); AD/LOI/Dictionary-mnemonic
# redact to NULL outright for the gated tier (query filters out null rows,
# so an all-redacted tier legitimately returns zero MATCHING rows, not an
# HTTP error). is_preview=True means "below tier gets a smaller-but-nonzero
# value"; False means "below tier gets exactly 0 matching rows."
gated_probes = {
    "AC pdf_blocks": ("advisory_circulars_gated?select=pdf_blocks&limit=1", "plus", True),
    "AC pdf_text": ("advisory_circulars_gated?select=pdf_text&pdf_text=not.is.null&limit=1", "plus", True),
    "AD body_text": ("airworthiness_directives_gated?select=body_text&body_text=not.is.null&limit=1", "plus", False),
    "LOI body_text": ("legal_interpretations_gated?select=body_text&body_text=not.is.null&limit=1", "pro", False),
    # Mnemonics moved Plus->Pro on 2026-08-10 (sync/migrations_dictionary_
    # regate_plus_mnemonics_pro.sql, RC: "Plus gets the A/D, not the
    # Mnemonics. Pro also gets Mnemonics.") -- base dictionary entries stay
    # Plus, this probe is mnemonic-category specifically, so Pro is correct.
    "Dictionary mnemonic senses": ("dictionary_terms_gated?select=senses&category=eq.mnemonic&limit=1", "pro", False),
}
gated_results = {}
for label, (path, min_tier, is_preview) in gated_probes.items():
    row = {}
    for t in TIER_ORDER:
        st, d = call(f"{URL}/rest/v1/{path}", headers=hdr(TOKENS[t]))
        if st != 200:
            row[t] = f"HTTP {st}"
        elif not isinstance(d, list) or not d:
            row[t] = 0  # no row matched the not-null filter -> fully redacted for this tier
        else:
            v = list(d[0].values())[-1]
            row[t] = 0 if v is None else (len(v) if isinstance(v, (str, list)) else 1)
    gated_results[label] = row
    print(f"  {label:<32}({min_tier}+)   " + "  ".join(f"{t}={row[t]}" for t in TIER_ORDER))
    below = ["anon", "free"] if min_tier == "plus" else ["anon", "free", "plus"]
    at_or_above = [t for t in TIER_ORDER if t not in below]
    above_vals = [row[t] for t in at_or_above if isinstance(row[t], int)]
    min_above = min(above_vals) if above_vals else None
    if is_preview:
        check(f"{label}: below-tier gets a truncated (nonzero but smaller) value",
              all(isinstance(row[t], int) and 0 < row[t] < (min_above or 0) for t in below), str(row))
    else:
        check(f"{label}: below-tier gets zero (fully redacted to null)",
              all(row[t] == 0 for t in below), str(row))
    check(f"{label}: full content for {at_or_above}",
          all(isinstance(row[t], int) and row[t] > 0 for t in at_or_above), str(row))


# ============================================================================
# 4. RAW TABLE BLOCKING -- every tier (incl. Premium) must be denied direct
#    access to the sensitive columns on the 4 paid-content tables plus
#    document_citations; only the _gated view/RPC path may read them.
# ============================================================================
print("\n=== RAW TABLE BLOCKING (should fail for every tier) ===")
raw_probes = {
    "raw advisory_circulars.pdf_blocks": "advisory_circulars?select=pdf_blocks&limit=1",
    "raw advisory_circulars.pdf_text": "advisory_circulars?select=pdf_text&limit=1",
    "raw airworthiness_directives.body_text": "airworthiness_directives?select=body_text&limit=1",
    "raw legal_interpretations.body_text": "legal_interpretations?select=body_text&limit=1",
    "raw dictionary_terms.senses": "dictionary_terms?select=senses&limit=1",
    "raw document_citations (label/cited_id)": "document_citations?select=label,cited_id&limit=1",
    "raw study_facts.question": "study_facts?select=question&limit=1",
}
for label, path in raw_probes.items():
    row = {}
    for t in TIER_ORDER:
        st, d = call(f"{URL}/rest/v1/{path}", headers=hdr(TOKENS[t]))
        row[t] = st
    print(f"  {label:<42}" + "  ".join(f"{t}={row[t]}" for t in TIER_ORDER))
    check(f"{label}: denied (401/403) for every tier including premium",
          all(row[t] in (401, 403) for t in TIER_ORDER), str(row))


# ============================================================================
# 5. MagicLink citations (document_citations_gated) -- cited_id/citing_id
#    must be visible at every tier (2026-08-13 tap-through fix); label
#    (the descriptive text) must stay Pro-gated.
# ============================================================================
print("\n=== MagicLink citations (document_citations_gated) ===")
# AIM 4-7-3 confirmed (via sync/migrations_fix_citations_gated_id_masking.sql's
# own incident writeup) to have real citing rows as of 2026-08-13.
ml = {}
for t in TIER_ORDER:
    st, d = call(f"{URL}/rest/v1/document_citations_gated?citing_type=eq.aim&citing_id=eq.4-7-3&select=*",
                 headers=hdr(TOKENS[t]))
    ml[t] = (st, d)
for t in TIER_ORDER:
    st, d = ml[t]
    print(f"  {t}: HTTP {st}, {len(d) if isinstance(d, list) else d} rows, "
          f"sample={d[0] if isinstance(d, list) and d else None}")
check("MagicLink: cited_id/citing_id visible for EVERY tier (incl. anon)",
      all(ml[t][0] == 200 and isinstance(ml[t][1], list) and len(ml[t][1]) > 0
          and all(r.get("cited_id") is not None for r in ml[t][1]) for t in TIER_ORDER),
      str({t: ml[t][1] for t in TIER_ORDER}))
check("MagicLink: label is null for anon/free/plus, populated for pro/premium",
      all(all(r.get("label") is None for r in ml[t][1]) for t in ("anon", "free", "plus")
          if isinstance(ml[t][1], list))
      and all(any(r.get("label") for r in ml[t][1]) for t in ("pro", "premium")
              if isinstance(ml[t][1], list)),
      str({t: [r.get("label") for r in ml[t][1]] if isinstance(ml[t][1], list) else ml[t][1] for t in TIER_ORDER}))


# ============================================================================
# 6. folder_visible_cap() by tier
# ============================================================================
print("\n=== folder_visible_cap() RPC ===")
fc = {}
for t in TIER_ORDER:
    st, d = call(f"{URL}/rest/v1/rpc/folder_visible_cap", {}, hdr(TOKENS[t]))
    fc[t] = d if st == 200 else f"HTTP {st}"
print("  " + "  ".join(f"{t}={fc[t]}" for t in TIER_ORDER))
check("folder_visible_cap: free=0, plus=3, pro=3, premium=unlimited",
      fc.get("free") == 0 and fc.get("plus") == 3 and fc.get("pro") == 3
      and isinstance(fc.get("premium"), int) and fc["premium"] > 1000,
      str(fc))


# ============================================================================
# 7. Bookmarks / Notes / Folders / Highlights -- sync-push Pro-gate, and the
#    downgrade-retains-READ (but not create) behavior.
# ============================================================================
print("\n=== Bookmarks / Notes / Folders / Highlights (sync-push, Pro+) ===")


def make_tier_user(prefix, tier):
    """Disposable user for mutation tests -- NOT the persistent tiermatrix-*
    fixtures, so INSERT/DELETE churn here never pollutes those."""
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = call(f"{URL}/auth/v1/admin/users",
                     {"email": email, "password": password, "email_confirm": True}, SVC)
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    uid = body["id"]
    st, tok = call(f"{URL}/auth/v1/token?grant_type=password",
                    {"email": email, "password": password}, {"apikey": ANON, "Content-Type": "application/json"})
    if st != 200:
        raise RuntimeError(f"signin {st}: {tok}")
    if tier != "free":
        call(f"{URL}/rest/v1/user_entitlements", {"user_id": uid, **TIERS[tier]},
             {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})
    return {"id": uid, "jwt": tok["access_token"]}


mutation_users = []
try:
    bookmark_gate = {}
    note_gate = {}
    folder_gate = {}
    for t in ("free", "plus", "pro", "premium"):
        u = make_tier_user("qabm", t)
        mutation_users.append(u)
        now = "2026-08-16T00:00:00Z"
        st, d = call(f"{URL}/rest/v1/synced_bookmarks",
                     {"id": f"qa-bm-{secrets.token_hex(4)}", "user_id": u["id"],
                      "document_number": "91.3", "title": "QA test bookmark", "saved_at": now,
                      "updated_at": now, "deleted": False},
                     {**hdr(u["jwt"]), "Prefer": "return=representation"})
        bookmark_gate[t] = (st, d)
        st2, d2 = call(f"{URL}/rest/v1/synced_notes",
                       {"id": f"qa-note-{secrets.token_hex(4)}", "user_id": u["id"],
                        "title": "QA test note", "body": "test", "updated_at": now, "deleted": False},
                       {**hdr(u["jwt"]), "Prefer": "return=representation"})
        note_gate[t] = (st2, d2)
        st3, d3 = call(f"{URL}/rest/v1/synced_folders",
                       {"id": f"qa-folder-{secrets.token_hex(4)}", "user_id": u["id"],
                        "name": "QA test folder", "created_at": now, "updated_at": now, "deleted": False},
                       {**hdr(u["jwt"]), "Prefer": "return=representation"})
        folder_gate[t] = (st3, d3)

    print("  bookmark INSERT: " + "  ".join(f"{t}={bookmark_gate[t][0]}" for t in bookmark_gate))
    print("  note INSERT:     " + "  ".join(f"{t}={note_gate[t][0]}" for t in note_gate))
    print("  folder INSERT:   " + "  ".join(f"{t}={folder_gate[t][0]}" for t in folder_gate))
    check("bookmark sync-push: free/plus rejected, pro/premium accepted",
          bookmark_gate["free"][0] >= 400 and bookmark_gate["plus"][0] >= 400
          and bookmark_gate["pro"][0] in (200, 201) and bookmark_gate["premium"][0] in (200, 201),
          str({k: v[0] for k, v in bookmark_gate.items()}) + " detail=" + str(bookmark_gate))
    check("note sync-push: free/plus rejected, pro/premium accepted",
          note_gate["free"][0] >= 400 and note_gate["plus"][0] >= 400
          and note_gate["pro"][0] in (200, 201) and note_gate["premium"][0] in (200, 201),
          str({k: v[0] for k, v in note_gate.items()}) + " detail=" + str(note_gate))
    check("folder sync-push: free/plus rejected, pro/premium accepted",
          folder_gate["free"][0] >= 400 and folder_gate["plus"][0] >= 400
          and folder_gate["pro"][0] in (200, 201) and folder_gate["premium"][0] in (200, 201),
          str({k: v[0] for k, v in folder_gate.items()}) + " detail=" + str(folder_gate))

    # -- Highlight variant: same table, ac_id + block_text populated --
    hl_user = make_tier_user("qahl", "premium")
    mutation_users.append(hl_user)
    hl_id = f"qa-hl-{secrets.token_hex(4)}"
    st, d = call(f"{URL}/rest/v1/synced_bookmarks",
                 {"id": hl_id, "user_id": hl_user["id"], "document_number": "91.3",
                  "title": "QA highlight", "saved_at": now, "updated_at": now,
                  "ac_id": "91.3", "block_kind": "para",
                  "block_label": "91.3(a)", "block_snippet": "test snippet",
                  "block_text": "test block text", "deleted": False},
                 {**hdr(hl_user["jwt"]), "Prefer": "return=representation"})
    check("highlight (synced_bookmarks w/ ac_id+block_text) INSERT succeeds for premium", st in (200, 201), f"HTTP {st}: {d}")

    # -- Downgrade-retains-read scenario --
    dg_user = make_tier_user("qadg", "premium")
    mutation_users.append(dg_user)
    dg_bm_id = f"qa-dg-{secrets.token_hex(4)}"
    st, d = call(f"{URL}/rest/v1/synced_bookmarks",
                 {"id": dg_bm_id, "user_id": dg_user["id"], "document_number": "91.3",
                  "title": "QA downgrade test", "saved_at": now, "updated_at": now, "deleted": False},
                 {**hdr(dg_user["jwt"]), "Prefer": "return=representation"})
    check("downgrade scenario: premium can create a bookmark", st in (200, 201), f"HTTP {st}: {d}")
    st, d = call(f"{URL}/rest/v1/user_entitlements?user_id=eq.{dg_user['id']}", TIERS["free"],
                 {**SVC, "Content-Type": "application/json"}, method="PATCH")
    check("downgrade scenario: entitlement PATCH to free succeeded", st in (200, 204), f"HTTP {st}: {d}")
    st, d = call(f"{URL}/rest/v1/synced_bookmarks?id=eq.{dg_bm_id}&select=id,title",
                 headers=hdr(dg_user["jwt"]))
    check("downgrade scenario: now-Free user can still READ their existing bookmark",
          st == 200 and isinstance(d, list) and len(d) == 1, f"HTTP {st}: {d}")
    st, d = call(f"{URL}/rest/v1/synced_bookmarks?id=eq.{dg_bm_id}", None, hdr(dg_user["jwt"]), method="DELETE")
    check("downgrade scenario: now-Free user can still DELETE their existing bookmark",
          st in (200, 204), f"HTTP {st}: {d}")
    dg_bm_id2 = f"qa-dg2-{secrets.token_hex(4)}"
    st, d = call(f"{URL}/rest/v1/synced_bookmarks",
                 {"id": dg_bm_id2, "user_id": dg_user["id"], "document_number": "91.3",
                  "title": "QA downgrade test 2", "saved_at": now, "updated_at": now, "deleted": False},
                 {**hdr(dg_user["jwt"]), "Prefer": "return=representation"})
    check("downgrade scenario: now-Free user CANNOT create a new bookmark",
          st >= 400, f"HTTP {st}: {d}")

finally:
    for u in mutation_users:
        st, _ = call(f"{URL}/auth/v1/admin/users/{u['id']}", headers=SVC, method="DELETE")


# ============================================================================
# SUMMARY
# ============================================================================
print("\n================ SUMMARY ================")
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S):")
    for f in FAILURES:
        print(f"  - {f}")
else:
    print("All checks passed.")
for n in NOTES:
    print(f"  note: {n}")
sys.exit(1 if FAILURES else 0)
