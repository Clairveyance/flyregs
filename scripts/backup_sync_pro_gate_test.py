#!/usr/bin/env python3
"""Live check that "Back up & sync" (folders/notes/bookmarks INSERT into the
synced_* tables) genuinely requires Pro server-side, not just the client's
own isSyncEnabled()/hasProAccess toggle -- direct REST calls across all 4
tiers (Free/Plus/Pro/Premium), bypassing the client UI entirely.

Written for the 2026-08-18 "more full gating checks" sweep (Folders/Notes/
Bookmarks/Saved/Back-up&sync/Duels) -- "Back up & sync requires Pro"
(confirmed correct by prior sessions) was in scope to VERIFY, not re-derive,
so this exists as the actual re-runnable proof of that rather than a
one-off. Mirrors folders_e2e_test.py's own account/http helpers.

Usage: python3 scripts/backup_sync_pro_gate_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import http, make_user, delete_user, ANON, SERVICE, NOW, FAILURES, check
import secrets

TIERS = {
    "free":    dict(is_unlocked=False, is_pro=False, is_premium=False),
    "plus":    dict(is_unlocked=True,  is_pro=False, is_premium=False),
    "pro":     dict(is_unlocked=True,  is_pro=True,  is_premium=False),
    "premium": dict(is_unlocked=True,  is_pro=True,  is_premium=True),
}


def set_tier(uid, tier):
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, **TIERS[tier]},
         headers={"Prefer": "resolution=merge-duplicates"})


def main():
    print("=== Back up & sync (synced_folders/synced_notes/synced_bookmarks INSERT) "
          "server-side Pro gate, direct REST, all 4 tiers ===")
    created = []
    try:
        for tier in ("free", "plus", "pro", "premium"):
            u = make_user(f"bus{tier[:2]}")
            created.append(u)
            set_tier(u["id"], tier)
            should_succeed = tier in ("pro", "premium")

            fid = "bus-" + secrets.token_hex(4)
            st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=u["jwt"],
                            body={"id": fid, "user_id": u["id"], "name": "x",
                                  "deleted": False, "created_at": NOW, "updated_at": NOW})
            ok = st < 300
            check(f"[{tier}] synced_folders INSERT {'succeeds' if should_succeed else 'is rejected'}",
                  ok == should_succeed, f"HTTP {st}: {body}")
            if ok:
                http("DELETE", f"/rest/v1/synced_folders?id=eq.{fid}", key=SERVICE)

            nid = "busn-" + secrets.token_hex(4)
            st, body = http("POST", "/rest/v1/synced_notes", key=ANON, jwt=u["jwt"],
                            body={"id": nid, "user_id": u["id"], "title": "x", "body": "x",
                                  "deleted": False, "updated_at": NOW})
            ok = st < 300
            check(f"[{tier}] synced_notes INSERT {'succeeds' if should_succeed else 'is rejected'}",
                  ok == should_succeed, f"HTTP {st}: {body}")
            if ok:
                http("DELETE", f"/rest/v1/synced_notes?id=eq.{nid}", key=SERVICE)

            bid = "busb-" + secrets.token_hex(4)
            st, body = http("POST", "/rest/v1/synced_bookmarks", key=ANON, jwt=u["jwt"],
                            body={"id": bid, "user_id": u["id"], "document_number": "91.3",
                                  "title": "x", "saved_at": NOW, "item_type": "far",
                                  "ac_id": "91.3", "deleted": False, "updated_at": NOW})
            ok = st < 300
            check(f"[{tier}] synced_bookmarks INSERT {'succeeds' if should_succeed else 'is rejected'}",
                  ok == should_succeed, f"HTTP {st}: {body}")
            if ok:
                http("DELETE", f"/rest/v1/synced_bookmarks?id=eq.{bid}", key=SERVICE)
    finally:
        for u in created:
            delete_user(u["id"])
    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All Back up & sync Pro-gate checks passed.")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
