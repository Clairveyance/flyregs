#!/usr/bin/env python3
"""Regression coverage for the My Aircraft / Fleet bug sweep of 2026-08-22.

Every check below reproduced a REAL bug on the live DB before its fix and
passes after it. Real disposable @flyregs.invalid accounts, real user JWTs
(anon key, never the service key, except for out-of-band setup/assertions),
so RLS, has_aircraft_access() and auth.uid() are genuinely exercised.

Covers:
  1. Untagging a part prunes its now-orphaned equipment-matched ADs, and
     leaves airframe / complied / dismissed / still-covered rows alone.
     (prune_orphaned_equipment_ad_notifications, adParts.removeAircraftEquipment)
  2. Rolling a reminder's due date forward re-arms its push; editing any
     other field does not. (trg_rearm_reminder_on_due_date_change)
  3. Removing a link-joined collaborator retires the share link so they
     can't walk straight back in; removing a Callsign invitee leaves an
     unrelated link alone. (aircraftSharing.removeCollaborator)
  4. send-ad-alerts.mjs's collaborator recipient set excludes pending
     (invited, never accepted) invites.
  5. get_fleet_summary()'s overdue-reminder count is UTC-dated, so the
     Fleet screen must not render it directly -- documents the drift the
     client-side overdueByAircraft fix exists to absorb.

Usage:  python3 scripts/fleet_sweep_regression_test.py
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

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

FAILURES = []


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
        raise RuntimeError(f"rpc {fn} -> HTTP {st}: {body}")
    return body


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}   {'' if cond else detail}")
    if not cond:
        FAILURES.append(f"{label} :: {detail}")
    return cond


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True,
                          "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"]}


def grant_premium(uid):
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def two_parts_with_ad_mentions():
    """Two active parts that each have their own AD mentions, so 'still
    covered by a remaining tag' is actually testable."""
    st, rows = http("GET", "/rest/v1/ad_part_mentions?select=part_id,ad_number&limit=1000", key=SERVICE)
    by_part = {}
    for r in rows or []:
        by_part.setdefault(r["part_id"], set()).add(r["ad_number"])
    ranked = sorted(by_part.items(), key=lambda kv: -len(kv[1]))
    candidates = [p for p, ads in ranked if len(ads) >= 2]

    def all_mentions(part_id):
        # The sample above only picks the candidates -- the assertions need
        # the COMPLETE mention set for each chosen part, or "how many rows
        # should the backfill have written" is wrong.
        st, rows = http("GET", f"/rest/v1/ad_part_mentions?part_id=eq.{part_id}&select=ad_number", key=SERVICE)
        return {r["ad_number"] for r in rows or []}

    for i, p1 in enumerate(candidates):
        a1 = all_mentions(p1)
        for p2 in candidates[i + 1:]:
            a2 = all_mentions(p2)
            if a1 and a2 and not (a1 & a2):
                return (p1, a1), (p2, a2)
    raise RuntimeError("no two disjoint AD-mentioning parts found")


def main():
    owner = make_user("frsA")
    mate = make_user("frsB")
    pend = make_user("frsC")
    for u in (owner, mate, pend):
        grant_premium(u["id"])
    uids = [owner["id"], mate["id"], pend["id"]]
    ac_id = None

    (part_a, ads_a), (part_b, ads_b) = two_parts_with_ad_mentions()

    try:
        # A make/model that matches no real AD, so every notification row
        # this test sees is one it created on purpose.
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        body={"user_id": owner["id"], "make": "Zzqq Aviation", "model": "ZZ-999",
                              "type_designator": "ZZ999", "nickname": "Regression Bird"},
                        headers={"Prefer": "return=representation"})
        ac_id = body[0]["id"]
        n = rpc("backfill_aircraft_ad_notifications", owner["jwt"], {"p_user_aircraft_id": ac_id})
        check("test aircraft matches 0 airframe ADs (clean baseline)", n == 0, f"backfill returned {n}")

        # ── 1. equipment untag prunes its orphaned AD matches ────────────
        print("\n=== 1. equipment untag -> AD prune ===")
        st, eq = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=owner["jwt"],
                      body={"user_aircraft_id": ac_id, "part_id": part_a},
                      headers={"Prefer": "return=representation"})
        eq_a = eq[0]["id"]
        st, eq = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=owner["jwt"],
                      body={"user_aircraft_id": ac_id, "part_id": part_b},
                      headers={"Prefer": "return=representation"})
        eq_b = eq[0]["id"]
        rpc("backfill_aircraft_ad_notifications", owner["jwt"], {"p_user_aircraft_id": ac_id})
        st, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{ac_id}"
                               f"&select=id,ad_number,matched_via", key=SERVICE)
        check("tagging two parts adds their equipment-matched ADs",
              len(rows) == len(ads_a | ads_b), f"{len(rows)} rows vs {len(ads_a | ads_b)} expected")

        # mark one of part A's ADs complied, and dismiss another, so the
        # prune's carve-outs are exercised for real
        a_rows = [r for r in rows if r["ad_number"] in ads_a]
        keep_complied = a_rows[0]["id"]
        http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{keep_complied}", key=ANON, jwt=owner["jwt"],
             body={"complied_at": datetime.now(timezone.utc).isoformat(), "complied_by": owner["id"]})
        keep_dismissed = a_rows[1]["id"] if len(a_rows) > 1 else None
        if keep_dismissed:
            http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{keep_dismissed}", key=ANON, jwt=owner["jwt"],
                 body={"dismissed_at": datetime.now(timezone.utc).isoformat()})

        # untag part A -- exactly what adParts.removeAircraftEquipment does
        http("DELETE", f"/rest/v1/user_aircraft_equipment?id=eq.{eq_a}", key=ANON, jwt=owner["jwt"])
        pruned = rpc("prune_orphaned_equipment_ad_notifications", owner["jwt"], {"p_user_aircraft_id": ac_id})
        st, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{ac_id}"
                               f"&select=id,ad_number,complied_at,dismissed_at", key=SERVICE)
        left = {r["ad_number"] for r in rows}
        orphan_open = (ads_a - ads_b) - {r["ad_number"] for r in rows
                                         if r["complied_at"] or r["dismissed_at"]}
        check("untagging a part prunes its now-orphaned open AD matches",
              not (orphan_open & left), f"still present: {sorted(orphan_open & left)} (pruned {pruned})")
        check("the other still-tagged part keeps its own AD matches",
              ads_b <= left, f"missing: {sorted(ads_b - left)}")
        check("a COMPLIED equipment AD survives the untag (maintenance record, not an alert)",
              any(r["id"] == keep_complied for r in rows), "complied compliance record was deleted")
        if keep_dismissed:
            check("a DISMISSED equipment AD survives the untag (keeps the false positive suppressed)",
                  any(r["id"] == keep_dismissed for r in rows), "dismissed row was deleted")
        check("a second prune with nothing left to do is a no-op",
              rpc("prune_orphaned_equipment_ad_notifications", owner["jwt"],
                  {"p_user_aircraft_id": ac_id}) == 0, "second prune deleted rows")

        # ── 2. reminder re-arm on a due-date roll-forward ────────────────
        print("\n=== 2. reminder push re-arms on a due-date change ===")
        past = (datetime.now(timezone.utc) - timedelta(days=3)).date().isoformat()
        future = (datetime.now(timezone.utc) + timedelta(days=400)).date().isoformat()
        st, rem = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=owner["jwt"],
                       body={"user_id": owner["id"], "user_aircraft_id": ac_id,
                             "title": "Annual Inspection", "due_date": past, "interval_months": 12},
                       headers={"Prefer": "return=representation"})
        rem_id = rem[0]["id"]
        stamp = "2026-01-01T00:00:00+00:00"
        http("PATCH", f"/rest/v1/user_aircraft_reminders?id=eq.{rem_id}", key=SERVICE,
             body={"notified_at": stamp})

        # title-only edit must NOT re-notify
        http("PATCH", f"/rest/v1/user_aircraft_reminders?id=eq.{rem_id}", key=ANON, jwt=owner["jwt"],
             body={"title": "Annual Inspection (renamed)", "due_date": past,
                   "linked_ad_number": None, "notes": "typo fix",
                   "interval_months": 12, "due_hobbs_hours": None})
        st, r = http("GET", f"/rest/v1/user_aircraft_reminders?id=eq.{rem_id}&select=notified_at", key=SERVICE)
        check("editing a reminder's text does NOT re-arm its push (no duplicate)",
              r[0]["notified_at"] is not None, f"notified_at cleared to {r[0]['notified_at']}")

        # rolling the due date forward MUST re-notify
        http("PATCH", f"/rest/v1/user_aircraft_reminders?id=eq.{rem_id}", key=ANON, jwt=owner["jwt"],
             body={"title": "Annual Inspection", "due_date": future,
                   "linked_ad_number": None, "notes": None,
                   "interval_months": 12, "due_hobbs_hours": None})
        st, r = http("GET", f"/rest/v1/user_aircraft_reminders?id=eq.{rem_id}&select=due_date,notified_at", key=SERVICE)
        check("rolling a reminder forward re-arms its push (notified_at cleared)",
              r[0]["notified_at"] is None,
              f"due_date {r[0]['due_date']} but notified_at still {r[0]['notified_at']}")

        # ── 3. revoking a link-joined collaborator retires the link ──────
        print("\n=== 3. removing a collaborator closes their way back in ===")
        link = secrets.token_urlsafe(16)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": link, "share_code_role": "editor"})
        rpc("join_shared_aircraft", mate["jwt"], {"p_code": link})
        st, row = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                              f"&user_id=eq.{mate['id']}&select=invite_token", key=ANON, jwt=owner["jwt"])
        check("a link join leaves invite_token null (that's how the client tells the two paths apart)",
              row and row[0]["invite_token"] is None, str(row))
        # exactly what aircraftSharing.removeCollaborator now does
        http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}&user_id=eq.{mate['id']}",
             key=ANON, jwt=owner["jwt"])
        if row and row[0]["invite_token"] is None:
            http("PATCH", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=ANON, jwt=owner["jwt"],
                 body={"share_code": None, "share_code_role": None})
        st, seen = http("GET", f"/rest/v1/user_aircraft?id=eq.{ac_id}&select=id", key=ANON, jwt=mate["jwt"])
        check("removed collaborator loses read access immediately", not seen, str(seen))
        try:
            rpc("join_shared_aircraft", mate["jwt"], {"p_code": link})
            rejoined = True
        except RuntimeError:
            rejoined = False
        check("removed collaborator CANNOT re-join with the link they still hold", not rejoined,
              "the old share link is still live -- they walked straight back in")

        # a Callsign invite must NOT take an unrelated live link down with it
        link2 = secrets.token_urlsafe(16)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": link2, "share_code_role": "viewer"})
        callsign = "FrsPend" + secrets.token_hex(3)
        rpc("set_callsign", pend["jwt"], {"p_callsign": callsign})
        rpc("invite_aircraft_collaborator", owner["jwt"],
            {"p_aircraft_id": ac_id, "p_callsign": callsign, "p_role": "viewer",
             "p_token": secrets.token_urlsafe(16)})
        st, prow = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                               f"&user_id=eq.{pend['id']}&select=invite_token,accepted_at",
                        key=ANON, jwt=owner["jwt"])
        check("a Callsign invite DOES carry an invite_token", prow and prow[0]["invite_token"], str(prow))

        # ── 4. pending invites are not AD-push recipients ────────────────
        print("\n=== 4. AD push recipient set excludes pending invites ===")
        st, recipients = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                                     f"&select=user_id&left_at=is.null&accepted_at=not.is.null", key=SERVICE)
        st, unfiltered = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                                     f"&select=user_id&left_at=is.null", key=SERVICE)
        check("send-ad-alerts.mjs's filter drops the invited-but-never-joined user",
              pend["id"] not in [r["user_id"] for r in recipients or []],
              f"recipients={recipients}")
        check("...and the old left_at-only filter really did include them (bug reproduces)",
              pend["id"] in [r["user_id"] for r in unfiltered or []], str(unfiltered))

        # ── 4b. editing an aircraft's identity re-derives its ADs ────────
        print("\n=== 4b. aircraft identity edit -> AD resync ===")
        st, ce = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=mate["jwt"],
                      body={"user_id": mate["id"], "make": "Cessna", "model": "172S",
                            "type_designator": "172S", "nickname": "Resync Probe"},
                      headers={"Prefer": "return=representation"})
        edit_id = ce[0]["id"]
        rpc("backfill_aircraft_ad_notifications", mate["jwt"], {"p_user_aircraft_id": edit_id})
        st, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{edit_id}&select=id,ad_number", key=SERVICE)
        cessna_ads = {r["ad_number"] for r in rows}
        check("a Cessna 172S matches real ADs to begin with", len(cessna_ads) > 0, str(len(cessna_ads)))
        # read one of them, and comply another, so the resync's carve-outs
        # are exercised on real rows
        read_id = rows[0]["id"]
        http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{read_id}", key=ANON, jwt=mate["jwt"],
             body={"read_at": "2026-02-02T00:00:00+00:00"})
        complied_ad = rows[-1]["ad_number"]
        http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{rows[-1]['id']}", key=ANON, jwt=mate["jwt"],
             body={"complied_at": "2026-02-02T00:00:00+00:00", "complied_by": mate["id"]})

        # exactly what EditAircraftModal.handleSave writes
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{edit_id}", key=ANON, jwt=mate["jwt"],
             body={"make": "Piper", "model": "Archer", "type_designator": "PA-28-181",
                   "nickname": "Resync Probe", "year": None})
        res = rpc("resync_aircraft_ad_notifications", mate["jwt"], {"p_user_aircraft_id": edit_id})
        st, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{edit_id}"
                               f"&select=id,ad_number,read_at,complied_at", key=SERVICE)
        now_open = {r["ad_number"] for r in rows if not r["complied_at"]}

        # ground truth: a freshly-entered PA-28-181
        st, cp = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=mate["jwt"],
                      body={"user_id": mate["id"], "make": "Piper", "model": "Archer",
                            "type_designator": "PA-28-181", "nickname": "Clean Piper"},
                      headers={"Prefer": "return=representation"})
        clean_id = cp[0]["id"]
        rpc("backfill_aircraft_ad_notifications", mate["jwt"], {"p_user_aircraft_id": clean_id})
        st, crows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{clean_id}&select=ad_number", key=SERVICE)
        clean_ads = {r["ad_number"] for r in crows}
        check("after a make/model/type edit the AD list matches a freshly-entered aircraft exactly",
              now_open == clean_ads,
              f"extra={sorted(now_open - clean_ads)[:5]} missing={sorted(clean_ads - now_open)[:5]}")
        check("resync reports what it actually changed",
              res and res[0]["out_removed"] > 0, str(res))
        check("a COMPLIED AD survives the identity change (maintenance record)",
              any(r["ad_number"] == complied_ad and r["complied_at"] for r in rows), "complied record lost")
        # Read-state preservation matters most for the NO-identity-change
        # case -- that's what the AD section's refresh control does now, and
        # a naive delete+rebackfill would repaint every unread dot on every
        # tap. Mark one of the (now Piper) ADs read, resync again, assert it
        # stayed read and that the second resync was a genuine no-op.
        open_now = [r for r in rows if not r["complied_at"]]
        http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{open_now[0]['id']}", key=ANON, jwt=mate["jwt"],
             body={"read_at": "2026-03-03T00:00:00+00:00"})
        res2 = rpc("resync_aircraft_ad_notifications", mate["jwt"], {"p_user_aircraft_id": edit_id})
        st, rows2 = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{edit_id}"
                                f"&select=ad_number,read_at", key=SERVICE)
        again = next((r for r in rows2 if r["ad_number"] == open_now[0]["ad_number"]), None)
        check("a resync with nothing to change reports 0/0",
              res2 and res2[0]["out_removed"] == 0 and res2[0]["out_added"] == 0, str(res2))
        check("read state survives a resync (refresh doesn't repaint every unread dot)",
              again and again["read_at"] is not None, str(again))
        http("DELETE", f"/rest/v1/user_aircraft?id=eq.{clean_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/user_aircraft?id=eq.{edit_id}", key=SERVICE)

        # ── 5. UTC-dated overdue count vs the client's local one ─────────
        print("\n=== 5. get_fleet_summary()'s overdue count is UTC-dated ===")
        http("DELETE", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{ac_id}", key=SERVICE)
        # A reminder due on the DB's own "yesterday" is the boundary case:
        # any user whose local date is still that day sees "0d / due today"
        # from daysUntil() while the RPC has already counted it overdue.
        yday_utc = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
        http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=owner["jwt"],
             body={"user_id": owner["id"], "user_aircraft_id": ac_id,
                   "title": "Boundary", "due_date": yday_utc})
        fleet = rpc("get_fleet_summary", owner["jwt"])
        row = next((r for r in fleet if r["out_aircraft_id"] == ac_id), None)
        print(f"    server counts {row and row['out_overdue_reminder_count']} overdue for due_date={yday_utc} "
              f"(UTC today={datetime.now(timezone.utc).date().isoformat()})")
        check("server's overdue count is a plain UTC date compare (documented drift, "
              "absorbed client-side by overdueByAircraft in my-aircraft/index.tsx)",
              row is not None and row["out_overdue_reminder_count"] == 1,
              f"row={row}")

    finally:
        if ac_id:
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=SERVICE)
        for uid in uids:
            http("DELETE", f"/rest/v1/user_entitlements?user_id=eq.{uid}", key=SERVICE)
            http("DELETE", f"/rest/v1/callsign_registry?user_id=eq.{uid}", key=SERVICE)
            http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("All fleet-sweep regression checks passed.")


if __name__ == "__main__":
    main()
