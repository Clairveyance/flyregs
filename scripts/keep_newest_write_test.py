#!/usr/bin/env python3
"""Live-verify the keep_newest_write trigger: a chronologically OLDER
write that arrives over the network LAST must not overwrite a newer one,
while normal forward-in-time edits must still apply. Covers all 4 tables
the migration touched.

Usage: python3 scripts/keep_newest_write_test.py
"""
import datetime
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import make_user, delete_user, http, check, note, FAILURES, NOTES, ANON

NOW = datetime.datetime.now(datetime.timezone.utc)


def iso(offset_seconds):
    return (NOW + datetime.timedelta(seconds=offset_seconds)).isoformat()


def main():
    print("=== keep_newest_write trigger verification ===")
    u = make_user("kwA")
    try:
        # ---------- synced_notes ----------
        print("\n--- synced_notes ---")
        nid = f"kw-note-{u['id']}"
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=u["jwt"],
             body={"id": nid, "user_id": u["id"], "title": "v1", "body": "v1 body", "updated_at": iso(0)})

        # Race: an OLDER write (from before v1, e.g. a delayed retry) arrives LAST.
        st, _ = http("POST", "/rest/v1/synced_notes?on_conflict=user_id,id", key=ANON, jwt=u["jwt"],
                      body={"id": nid, "user_id": u["id"], "title": "STALE", "body": "should be rejected", "updated_at": iso(-30)},
                      headers={"Prefer": "resolution=merge-duplicates"})
        st2, rows = http("GET", f"/rest/v1/synced_notes?id=eq.{nid}&select=title", key=ANON, jwt=u["jwt"])
        check("stale (older) note write did NOT overwrite the newer content", rows[0]["title"] == "v1", str(rows))

        # Normal case: a genuinely NEWER write must still apply.
        st, _ = http("POST", "/rest/v1/synced_notes?on_conflict=user_id,id", key=ANON, jwt=u["jwt"],
                      body={"id": nid, "user_id": u["id"], "title": "v2", "body": "v2 body", "updated_at": iso(60)},
                      headers={"Prefer": "resolution=merge-duplicates"})
        st2, rows = http("GET", f"/rest/v1/synced_notes?id=eq.{nid}&select=title", key=ANON, jwt=u["jwt"])
        check("genuinely newer note write DID apply", rows[0]["title"] == "v2", str(rows))

        # ---------- synced_bookmarks ----------
        print("\n--- synced_bookmarks ---")
        bid = f"kw-bm-{u['id']}"
        st, body = http("POST", "/rest/v1/synced_bookmarks", key=ANON, jwt=u["jwt"],
                         body={"id": bid, "user_id": u["id"], "item_type": "far", "document_number": "91.3",
                               "title": "Sec 91.3", "saved_at": iso(0), "updated_at": iso(0)},
                         headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"insert bookmark: HTTP {st}: {body}")
        st, body = http("POST", "/rest/v1/synced_bookmarks?on_conflict=user_id,id", key=ANON, jwt=u["jwt"],
                         body={"id": bid, "user_id": u["id"], "item_type": "far", "document_number": "STALE",
                               "title": "Sec 91.3", "saved_at": iso(0), "updated_at": iso(-30)},
                         headers={"Prefer": "resolution=merge-duplicates"})
        if st >= 300:
            raise RuntimeError(f"upsert stale bookmark: HTTP {st}: {body}")
        st2, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{bid}&select=document_number", key=ANON, jwt=u["jwt"])
        check("stale (older) bookmark write did NOT overwrite the newer content", rows[0]["document_number"] == "91.3", str(rows))

        # ---------- synced_folders ----------
        print("\n--- synced_folders ---")
        fid = f"kw-folder-{u['id']}"
        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=u["jwt"],
                         body={"id": fid, "user_id": u["id"], "name": "Original", "created_at": iso(0), "updated_at": iso(0)},
                         headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"insert folder: HTTP {st}: {body}")
        st, body = http("POST", "/rest/v1/synced_folders?on_conflict=user_id,id", key=ANON, jwt=u["jwt"],
                         body={"id": fid, "user_id": u["id"], "name": "STALE", "created_at": iso(0), "updated_at": iso(-30)},
                         headers={"Prefer": "resolution=merge-duplicates"})
        if st >= 300:
            raise RuntimeError(f"upsert stale folder: HTTP {st}: {body}")
        st2, rows = http("GET", f"/rest/v1/synced_folders?id=eq.{fid}&select=name", key=ANON, jwt=u["jwt"])
        check("stale (older) folder write did NOT overwrite the newer content", rows[0]["name"] == "Original", str(rows))

        # cleanup rows (user delete cascades most, but be tidy regardless)
        http("DELETE", f"/rest/v1/synced_notes?id=eq.{nid}", key=ANON, jwt=u["jwt"])
        http("DELETE", f"/rest/v1/synced_bookmarks?id=eq.{bid}", key=ANON, jwt=u["jwt"])
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{fid}", key=ANON, jwt=u["jwt"])

    finally:
        delete_user(u["id"])

    print("\n================ SUMMARY ================")
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All checks passed.")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
