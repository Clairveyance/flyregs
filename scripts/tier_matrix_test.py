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
    one("CFR49 body_text","cfr49_sections_gated?select=body_text&body_text=not.is.null&limit=1")
    one("mnemonic senses","dictionary_terms_gated?select=senses&category=eq.mnemonic&limit=1")
    # Added 2026-08-19/20, full gating re-sweep -- search_dictionary() (the
    # RPC behind BOTH the Dictionary screen's own search bar and Home's
    # federated SmartSearch, unifiedSearch.ts) returned d.senses->>'definition'
    # completely unredacted for EVERY tier including fully anonymous, zero
    # session -- confirmed live via a raw curl with just the public anon key.
    # dictionary_terms_gated (the view every detail screen reads through)
    # was correctly gated since 2026-08-04/05; this RPC read the same paid
    # column from the same raw table but was never brought into line. Fixed
    # in sync/migrations_fix_search_dictionary_definition_leak.sql -- expect
    # a real definition string (non-null "1") for anon/free on a Plus-tier
    # (non-mnemonic) term, and null for a mnemonic-category term below Pro.
    st, d = call(f"{URL}/rest/v1/rpc/search_dictionary", {"query": "tornado", "result_limit": 1},
                 {**H, "Content-Type": "application/json"})
    out["search_dictionary definition (Plus+)"] = (
        (0 if d[0].get("definition") is None else 1) if st == 200 and isinstance(d, list) and d else f"HTTP {st}"
    )
    st, d = call(f"{URL}/rest/v1/rpc/search_dictionary", {"query": "marc", "result_limit": 3},
                 {**H, "Content-Type": "application/json"})
    mnem_row = next((r for r in d if r.get("slug") == "mnem-marc"), None) if st == 200 and isinstance(d, list) else None
    out["search_dictionary mnemonic def (Pro+)"] = (
        (0 if mnem_row.get("definition") is None else 1) if mnem_row else f"HTTP {st}"
    )
    one("raw AC (blocked)","advisory_circulars?select=pdf_blocks&limit=1")
    # Added 2026-08-19/20, full gating re-sweep -- advisory_circulars_gated/
    # legal_interpretations_gated have correctly redacted pdf_url_cached via
    # CASE for a long time, but the RAW tables' own column-level GRANTs
    # never included it in the denied list (migrations_paid_content_column_
    # privileges.sql only ever listed pdf_blocks/pdf_text/body_text/
    # search_vector) -- live-confirmed exploitable with nothing but the
    # public anon key: a raw `advisory_circulars?select=pdf_url_cached`
    # returned a real Supabase-storage PDF URL for a Plus-gated AC, same for
    # legal_interpretations at Pro. Same bug shape as the study_facts RAW
    # probe above and gotcha_rls_does_not_gate_columns.md generally -- a
    # gated VIEW proves nothing about the RAW table underneath it. Fixed in
    # sync/migrations_fix_pdf_url_cached_column_grant_leak.sql (also closed
    # advisory_circulars.changed_block_indices, dormant but same gap).
    # These probes expect "HTTP 401"/"HTTP 403" for every tier including
    # anon, never a real URL -- this is the regression guard.
    one("raw AC pdf_url_cached (blocked)", "advisory_circulars?select=pdf_url_cached&pdf_url_cached=not.is.null&limit=1")
    one("raw LOI pdf_url_cached (blocked)", "legal_interpretations?select=pdf_url_cached&pdf_url_cached=not.is.null&limit=1")
    one("raw AC changed_block_indices (blocked)", "advisory_circulars?select=changed_block_indices&limit=1")
    # Added 2026-08-29, full-sweep pass 4 (Search/SmartSearch) -- cfr49_
    # sections_gated (probed above) has correctly redacted body_text since
    # it was created, but nobody had ever added the matching raw-table probe
    # this exact bug shape needs, and the raw table's own column grant was
    # never revoked -- live-confirmed exploitable with nothing but the
    # public anon key: a raw `cfr49_sections?select=body_text` returned full
    # real TSA-security-program text for every tier including anon. An
    # earlier audit had grouped cfr49_sections with far_sections/aim_
    # paragraphs/pcg_terms as "correctly open" (true for those three --
    # 100% free content -- but CFR49 does have a real Plus gate). Fixed in
    # sync/migrations_fix_cfr49_body_text_column_grant_leak.sql. Expect
    # "HTTP 401"/"HTTP 403" for every tier including anon, never real text.
    one("raw CFR49 body_text (blocked)", "cfr49_sections?select=body_text&body_text=not.is.null&limit=1")
    # search_acs() is SECURITY DEFINER, so the raw-table column-grant fix
    # above doesn't reach it -- it returns pdf_url_cached unconditionally on
    # every row, live-confirmed exploitable via a plain anon POST. Fixed in
    # sync/migrations_fix_search_acs_pdf_url_leak.sql. Expect null for
    # anon/free, a real URL ("1") for Plus+.
    st, d = call(f"{URL}/rest/v1/rpc/search_acs", {"query": "maintenance", "result_limit": 1},
                 {**H, "Content-Type": "application/json"})
    out["search_acs pdf_url_cached (Plus+)"] = (
        (0 if d[0].get("pdf_url_cached") is None else 1) if st == 200 and isinstance(d, list) and d else f"HTTP {st}"
    )
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
    # Added 2026-08-12, post-create_challenge-fix re-sweep -- a real, live,
    # SEVERE gap this file's own coverage never caught: get_study_pool_count
    # (the line above) has always had the has_pro_access() gate, but its
    # sibling get_study_queue() -- the RPC that actually returns real card
    # CONTENT (far/aim body_text, pcg definitions) -- had NONE, for every
    # tier, and this harness never once called it. Confirmed and fixed same
    # session (sync/migrations_fix_get_study_queue_missing_pro_gate.sql);
    # this probe is the actual regression guard going forward, same
    # "extend coverage, don't just fix today's instance" reasoning as the
    # 2026-08-11 block above.
    st, d = call(f"{URL}/rest/v1/rpc/get_study_queue", {"p_limit": 5}, {**H, "Content-Type": "application/json"})
    out["Study Mode queue"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    # Same session, same re-sweep: study_facts (the authored Study Mode/
    # Duels question+answer bank, incl. the 393 live Opus-repaired rows)
    # had SELECT granted directly to anon+authenticated with only a
    # status='live' RLS filter -- no tier check at all, exploitable via a
    # single unauthenticated REST call. Fixed alongside get_study_queue in
    # the same migration (raw table grant revoked, study_facts_gated added
    # redacting question/answer/distractors/source_quote for non-Pro,
    # src/lib/study.ts switched to the gated view). This probe checks the
    # raw table is actually locked down -- expect "HTTP 401"/"HTTP 403" for
    # every tier including anon, never a real column length.
    one("study_facts RAW (should be blocked)", "study_facts?select=question&question=not.is.null&limit=1")
    one("study_facts_gated question", "study_facts_gated?select=question&question=not.is.null&limit=1")
    st, d = call(f"{URL}/rest/v1/rpc/get_reg_of_the_day", {}, {**H, "Content-Type": "application/json"})
    out["DailyReg"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    # Added 2026-08-19/20, access-points sweep (Edge Functions / deep-links /
    # push payloads) -- get_word_of_the_day()'s pool is drawn from ALL of
    # dictionary_terms with no category filter (52 real mnemonic rows are
    # eligible), and its redaction used to check ONLY has_plus_access(),
    # never has_pro_access() for a category='mnemonic' row the way
    # dictionary_terms_gated correctly does. Live-confirmed the date-hash
    # rotation lands on a real mnemonic ("5 Ps") on 2026-09-11 -- pinning the
    # probe to that exact date reproduces the exact live exploit rather than
    # a synthetic one. Before the fix this leaked two ways: the DailyWord
    # PUSH (scripts/send-word-of-day.mjs sends to every Plus+ recipient
    # regardless of the day's category) and the in-app DailyWordCard
    # (dictionary/index.tsx, gated client-side on hasPlusAccess only).
    # Fixed in sync/migrations_fix_word_of_day_mnemonic_leak.sql (mirrors
    # dictionary_terms_gated's redaction shape) + send-word-of-day.mjs (per-
    # day recipient gate now Pro+ when category='mnemonic') +
    # DailyWordCard (branches on definition truthiness, not hasPlusAccess
    # alone). Expect null definition below Pro, real text at Pro+.
    st, d = call(f"{URL}/rest/v1/rpc/get_word_of_the_day", {"for_date": "2026-09-11"},
                 {**H, "Content-Type": "application/json"})
    out["DailyWord mnemonic def (Pro+)"] = (
        (0 if d[0].get("definition") is None else 1) if st == 200 and isinstance(d, list) and d else f"HTTP {st}"
    )
    st, d = call(f"{URL}/rest/v1/rpc/search_far", {"query": "aircraft", "result_limit": 200},
                 {**H, "Content-Type": "application/json"})
    out["search depth"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    # Added 2026-08-21, gating-audit follow-up -- search_ads/search_legal_
    # interpretations (added 2026-08-20, migrations_search_ad_loi_parity.sql,
    # for AD/LOI search parity with search_acs) were never added to this
    # harness, so a live audit had to write a one-off probe by hand to
    # confirm the depth clamp (10 rows below Plus, up to 200 at Plus+) was
    # actually wired the same way search_far/search_acs already are. Neither
    # RPC returns body_text at any tier (they're metadata-only search
    # results -- full text stays behind the separate *_gated views, already
    # covered by the "AD body_text"/"LOI body_text" probes above), so depth
    # is the only real gating surface here. Extending coverage now so this
    # doesn't need re-discovering by hand on the next audit.
    st, d = call(f"{URL}/rest/v1/rpc/search_ads", {"query": "cessna", "result_limit": 200},
                 {**H, "Content-Type": "application/json"})
    out["search_ads depth"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
    st, d = call(f"{URL}/rest/v1/rpc/search_legal_interpretations", {"q": "maintenance", "lim": 200},
                 {**H, "Content-Type": "application/json"})
    out["search_loi depth"] = len(d) if st == 200 and isinstance(d, list) else f"HTTP {st}"
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

# Added 2026-08-19/20, different-access-points gating sweep -- not a
# per-tier probe (rate limiting isn't a tier concept, it runs pre-account,
# with just the anon key -- src/context/auth.tsx's signUp() calls it before
# supabase.auth.signUp() even exists). check_and_record_signup_attempt(
# p_device_id, p_max_per_hour) is the per-device anti-abuse signup rate
# limiter; its own code comment says "enforced server-side ... so it can't
# be bypassed by just not calling it" -- true for the app's own fixed
# p_max_per_hour=3 call, but the RPC is exposed to anon and p_max_per_hour
# was a live caller-supplied value with no server ceiling, so anyone could
# call it directly with p_max_per_hour=999999 and the limiter never
# tripped, regardless of how exhausted the real 3/hr limit already was for
# that device_id. Live-confirmed exploitable pre-fix; fixed in
# sync/migrations_fix_signup_rate_limit_bypass.sql by pinning the actual
# comparison to a fixed server-side constant and ignoring the caller's
# p_max_per_hour value for enforcement (kept as a parameter only so the
# existing call signature/client code doesn't need to change).
import time as _time
_device = f"tier-matrix-ratelimit-probe-{int(_time.time())}"
_hdrs = {"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}
for _ in range(3):
    call(f"{URL}/rest/v1/rpc/check_and_record_signup_attempt",
         {"p_device_id": _device, "p_max_per_hour": 3}, _hdrs)
_, _blocked_normal = call(f"{URL}/rest/v1/rpc/check_and_record_signup_attempt",
                          {"p_device_id": _device, "p_max_per_hour": 3}, _hdrs)
_, _bypass_attempt = call(f"{URL}/rest/v1/rpc/check_and_record_signup_attempt",
                          {"p_device_id": _device, "p_max_per_hour": 999999}, _hdrs)
call(f"{URL}/rest/v1/device_signup_attempts?device_id=eq.{_device}", method="DELETE",
     headers={**SVC, "Prefer": "return=minimal"})
print()
print(f"{'signup rate-limit: normal 4th call blocked':<{w}}{str(_blocked_normal is False):>13}  (expect True)")
print(f"{'signup rate-limit: p_max_per_hour bypass blocked':<{w}}{str(_bypass_attempt is False):>13}  (expect True)")
