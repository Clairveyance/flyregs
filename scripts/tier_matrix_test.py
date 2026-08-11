#!/usr/bin/env python3
"""Server-side tier gating matrix -- every gated surface, as every tier.

Deliberately scripted, not click-through: the `?tier=` override is a WEB
CLIENT stub (revenuecat.web.ts) and the server has never heard of it, so
clicking around the preview proves nothing about the real gates. Server
tier comes from `user_entitlements`, so this drives real accounts with real
entitlement rows and calls the real endpoints.

Test accounts use @flyregs.invalid -- admin-API signups on a real domain
fire real welcome emails (gotcha_test_users_send_welcome_email.md).

Usage: python3 scripts/tier_matrix_test.py
"""
import json, os, re, sys, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
        # No timeout here once hung a whole run_all_audits.sh --full
        # invocation for 27+ hours (2026-08-10, gotcha_tabbar_reverts...'s
        # companion writeup) -- a stalled server response froze the script
        # with zero output, indistinguishable from "still working." 30s is
        # generous for every real call this script makes (auth, PostgREST,
        # the semantic-search Edge Function) but still finite.
        with urllib.request.urlopen(r, timeout=30) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try: return e.code, json.loads(body)
        except Exception: return e.code, body[:150]

TIERS = {
    "free":    dict(is_pro=False, is_premium=False, is_unlocked=False),
    "plus":    dict(is_pro=False, is_premium=False, is_unlocked=True),
    "pro":     dict(is_pro=True,  is_premium=False, is_unlocked=True),
    "premium": dict(is_pro=True,  is_premium=True,  is_unlocked=True),
}

def ensure_user(tier):
    email = f"tiermatrix-{tier}@flyregs.invalid"
    st, out = call(f"{URL}/auth/v1/admin/users", {"email": email, "password": "Fl!" + tier + "-Matrix-9137",
                                                  "email_confirm": True}, SVC)
    if st in (200, 201):
        uid = out["id"]
    else:  # already exists -- look it up
        st, out = call(f"{URL}/auth/v1/admin/users?page=1&per_page=200", headers=SVC)
        uid = next(u["id"] for u in out["users"] if u["email"] == email)
    call(f"{URL}/rest/v1/user_entitlements", {"user_id": uid, **TIERS[tier],
         "updated_at": "2026-08-05T00:00:00Z"},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})
    _, link = call(f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email}, SVC)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    _, sess = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                   {"apikey": ANON, "Content-Type": "application/json"})
    return uid, sess["access_token"]

def probes(H):
    out = {}
    def one(label, path):
        st, d = call(f"{URL}/rest/v1/{path}", headers=H)
        if st != 200 or not isinstance(d, list) or not d: out[label] = f"HTTP {st}"; return
        v = list(d[0].values())[-1]
        out[label] = 0 if v is None else (len(v) if isinstance(v, (str, list)) else 1)
    one("AC pdf_blocks",  "advisory_circulars_gated?select=pdf_blocks&limit=1")
    one("AC pdf_text",    "advisory_circulars_gated?select=pdf_text&pdf_text=not.is.null&limit=1")
    one("AD body_text",   "airworthiness_directives_gated?select=body_text&body_text=not.is.null&limit=1")
    one("LOI body_text",  "legal_interpretations_gated?select=body_text&body_text=not.is.null&limit=1")
    one("mnemonic senses","dictionary_terms_gated?select=senses&category=eq.mnemonic&limit=1")
    one("raw AC (blocked)","advisory_circulars?select=pdf_blocks&limit=1")
    st, _ = call(f"{URL}/functions/v1/semantic-search",
                 {"query": "how much rest before flying passengers", "matchCount": 2},
                 {**H, "Content-Type": "application/json"})
    out["AskFlyRegs"] = f"HTTP {st}"
    st, d = call(f"{URL}/rest/v1/rpc/fleet_visible_cap", {}, {**H, "Content-Type": "application/json"})
    out["fleet cap"] = d if st == 200 else f"HTTP {st}"
    # Added 2026-08-11, app-wide gating sweep -- these 6 were all real, live
    # gaps found by real disposable-account testing (not the ?tier= stub)
    # that this script's own narrower coverage never would have caught
    # (it passed clean both before AND after each one was fixed). Extending
    # coverage here is the actual fix for "keeps finding more gating
    # issues" -- a one-off audit finds today's gaps, this is what stops
    # tomorrow's regression of the SAME ones.
    one("AD revision text","content_revisions_gated?select=added_text&doc_type=eq.ad&added_text=not.is.null&limit=1")
    one("MagicLink cited_id","document_citations_gated?select=cited_id&cited_type=eq.far&cited_id=not.is.null&limit=1")
    one("AD parts",        "ad_parts?select=name&status=eq.active&limit=1")
    st, d = call(f"{URL}/rest/v1/rpc/filter_documents", {"p_content_types": ["loi"], "p_limit": 1},
                 {**H, "Content-Type": "application/json"})
    out["filter_documents"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    st, d = call(f"{URL}/rest/v1/rpc/get_study_pool_count", {}, {**H, "Content-Type": "application/json"})
    out["Study Mode pool"] = d if st == 200 else f"HTTP {st}"
    st, d = call(f"{URL}/rest/v1/rpc/get_reg_of_the_day", {}, {**H, "Content-Type": "application/json"})
    out["DailyReg"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    st, d = call(f"{URL}/rest/v1/rpc/search_far", {"query": "aircraft", "result_limit": 200},
                 {**H, "Content-Type": "application/json"})
    out["search depth"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    return out

rows = {}
rows["anon"] = probes({"apikey": ANON, "Authorization": f"Bearer {ANON}"})
for tier in TIERS:
    uid, tok = ensure_user(tier)
    rows[tier] = probes({"apikey": ANON, "Authorization": f"Bearer {tok}"})

cols = list(rows["anon"].keys())
w = max(len(c) for c in cols) + 2
print(f"{'surface':<{w}}" + "".join(f"{t:>13}" for t in rows))
print("-" * (w + 13 * len(rows)))
for c in cols:
    print(f"{c:<{w}}" + "".join(f"{str(rows[t][c]):>13}" for t in rows))
