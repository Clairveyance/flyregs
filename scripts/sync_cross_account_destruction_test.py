#!/usr/bin/env python3
"""Live cross-account destruction/leak test for the synced_* sync tables.

Driven as TWO REAL authenticated users with real JWTs (anon key, never the
service key, for every attack call) so RLS and auth.uid() are genuinely
exercised -- same idiom as duel_e2e_test.py / three_gap_rls_test.py, whose
helpers this reuses.

WHY THIS EXISTS
---------------
syncPush.ts's syncPushNoteDeletes and syncPushFolderItemDeletes deliberately
send an UNFILTERED `.update({deleted:true}).in('id', ids)` -- no
`.eq('user_id', ...)` at all -- and say so in their own comments:

    "No .eq('user_id', ...) filter -- RLS is the real authority here"

That makes RLS the ONLY thing standing between one account's delete call and
another account's rows, so RLS is what this file tests. The specific policies
under test are synced_notes' `owners_manage_shared_notes` / `editors_manage_
shared_notes` and synced_bookmarks_gated's own WHERE clause, all three of
which reach a row purely by `synced_folder_items.item_id = <row>.id` with NO
requirement that the row's owner has anything to do with that folder.

The hypothesis: a user who owns a folder can point a folder_item at ANY
item_id and thereby acquire that policy's grant over a STRANGER's row of the
same id -- ownership of the folder standing in for ownership of the item.
`enforce_folder_item_access` (the BEFORE INSERT trigger on
synced_folder_items) only validates the FOLDER, never the item_id, so nothing
blocks the pointer from being created.

Two ways an attacker gets a target id:
  * bookmarks -- a whole-doc bookmark's id IS the document's own public id
    (bookmarks.ts: "id === acId" for a whole-doc bookmark), identical for
    every user who bookmarked it, so it needs no guessing at all;
  * notes -- a random makeNoteId(), NOT guessable in bulk, but permanently
    remembered by anyone who was ever a collaborator in a folder holding it.
    Removing that collaborator revokes has_folder_access and therefore
    `editors_manage_shared_notes` -- but they can re-acquire the same reach
    through `owners_manage_shared_notes` by pointing their OWN folder at the
    remembered id. This test hands the attacker the id directly, which models
    exactly that ex-collaborator, without needing to script a full share.

Every row this test touches belongs to one of its own two disposable
@flyregs.invalid accounts, both deleted in the `finally`. The bookmark id is
a synthetic 'zz-xacct-audit-*' string, never a real document id, so no real
user's row is ever selected, updated, or deleted.

Usage: python3 scripts/sync_cross_account_destruction_test.py
"""
import datetime
import os
import secrets
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from duel_e2e_test import (  # noqa: E402
    make_user, delete_user, http, check, note, FAILURES, NOTES, SERVICE, ANON,
)


def now_iso(offset_seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(seconds=offset_seconds)).isoformat()


def make_note_id():
    """Mirrors notes.ts makeNoteId(): base36 ms timestamp + 5 random base36."""
    return format(int(time.time() * 1000), 'x') + secrets.token_hex(3)


def grant_pro(uid):
    """has_pro_access gates folder ownership (enforce_folder_item_access);
    has_premium gates notes/sharing. Granted directly via the DB for a
    disposable account -- same pattern as tier_matrix_test.py, not a real
    purchase."""
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True, "is_pro": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def main():
    print("=== cross-account destruction / leak test: synced_notes + synced_bookmarks ===")
    victim = make_user("xacctV")
    attacker = make_user("xacctA")
    grant_pro(victim["id"])
    grant_pro(attacker["id"])
    note(f"victim={victim['id']}  attacker={attacker['id']}")

    try:
        # ── attacker's own folder: the only thing they legitimately own ──────
        f_a = f"xacct-attacker-folder-{attacker['id']}"
        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=attacker["jwt"],
                        body={"id": f_a, "user_id": attacker["id"], "name": "Attacker's own folder",
                              "created_at": now_iso(), "updated_at": now_iso()},
                        headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"attacker folder insert HTTP {st}: {body}")
        note(f"attacker created their OWN private folder {f_a}")

        # ═══════════════ 1. synced_notes: cross-account write/delete ═════════
        print("\n--- 1. synced_notes (never shared, never in any shared folder) ---")
        note_id = make_note_id()
        st, body = http("POST", "/rest/v1/synced_notes", key=ANON, jwt=victim["jwt"],
                        body={"id": note_id, "user_id": victim["id"], "title": "Victim private note",
                              "body": "ORIGINAL VICTIM BODY", "linked_ac": None,
                              "updated_at": now_iso()},
                        headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"victim note insert HTTP {st}: {body}")
        note(f"victim created private note {note_id}, never shared with anyone")

        # Baseline: with no folder_item pointing at it, the attacker is blind.
        st, seen = http("GET", f"/rest/v1/synced_notes?select=id,body&id=eq.{note_id}",
                        key=ANON, jwt=attacker["jwt"])
        check("BASELINE: attacker cannot SELECT the victim's note", seen == [], str(seen))

        st, patched = http("PATCH", f"/rest/v1/synced_notes?id=eq.{note_id}", key=ANON,
                           jwt=attacker["jwt"],
                           body={"body": "BASELINE OVERWRITE", "updated_at": now_iso(3600)},
                           headers={"Prefer": "return=representation"})
        check("BASELINE: attacker's UPDATE of the victim's note affects 0 rows",
              patched == [], f"HTTP {st}: {patched}")

        # ── the attack: point the attacker's OWN folder at the victim's id ──
        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=attacker["jwt"],
                        body={"id": f"xacct-item-note-{secrets.token_hex(4)}",
                              "user_id": attacker["id"], "folder_id": f_a,
                              "item_type": "note", "item_id": note_id,
                              "added_at": now_iso(), "updated_at": now_iso(), "deleted": False},
                        headers={"Prefer": "return=representation"})
        pointer_created = st < 300
        check("attacker CAN point their own folder at a stranger's note id "
              "(enforce_folder_item_access validates only the folder, never item_id)",
              pointer_created, f"HTTP {st}: {body}")
        if not pointer_created:
            note("pointer insert refused -- the rest of section 1 is moot")
        else:
            st, seen = http("GET", f"/rest/v1/synced_notes?select=id,user_id,title,body&id=eq.{note_id}",
                            key=ANON, jwt=attacker["jwt"])
            leak_read = bool(seen)
            check("ATTACK: attacker still CANNOT read the victim's note",
                  not leak_read, f"READ LEAK -- attacker got: {seen}")
            if leak_read:
                NOTES.append("CONFIRMED: owners_manage_shared_notes grants SELECT on a "
                             "stranger's note via a self-owned folder pointer")

            st, patched = http("PATCH", f"/rest/v1/synced_notes?id=eq.{note_id}", key=ANON,
                               jwt=attacker["jwt"],
                               body={"body": "OVERWRITTEN BY ATTACKER", "updated_at": now_iso(3600)},
                               headers={"Prefer": "return=representation"})
            # Authoritative re-read as service role -- never trust the attacker's
            # own response body to tell us whether the row really changed.
            st2, truth = http("GET", f"/rest/v1/synced_notes?select=body,deleted&id=eq.{note_id}",
                              key=SERVICE)
            overwritten = bool(truth) and truth[0]["body"] != "ORIGINAL VICTIM BODY"
            check("ATTACK: the victim's note body is UNCHANGED after the attacker's UPDATE",
                  not overwritten, f"DESTRUCTIVE WRITE -- row now reads: {truth}")
            if overwritten:
                NOTES.append("CONFIRMED: a stranger can OVERWRITE another user's note body")

            st, _ = http("DELETE", f"/rest/v1/synced_notes?id=eq.{note_id}", key=ANON,
                         jwt=attacker["jwt"])
            st2, truth = http("GET", f"/rest/v1/synced_notes?select=id&id=eq.{note_id}", key=SERVICE)
            destroyed = truth == []
            check("ATTACK: the victim's note row still EXISTS after the attacker's DELETE",
                  not destroyed, "HARD DELETE -- the victim's row is gone from the table")
            if destroyed:
                NOTES.append("CONFIRMED: a stranger can HARD-DELETE another user's synced_notes row")

        # ═══════════════ 2. synced_bookmarks_gated: cross-account read ═══════
        print("\n--- 2. synced_bookmarks_gated (whole-doc bookmark, id == public doc id) ---")
        doc_id = f"zz-xacct-audit-{secrets.token_hex(4)}"  # synthetic, never a real doc
        st, body = http("POST", "/rest/v1/rpc/push_bookmark", key=ANON, jwt=victim["jwt"],
                        body={"p_id": doc_id, "p_document_number": "ZZ-AUDIT",
                              "p_title": "Victim bookmark", "p_date_issued": None,
                              "p_office": None, "p_subject_series": None,
                              "p_saved_at": now_iso(), "p_item_type": "ac",
                              "p_ac_id": doc_id, "p_block_kind": "para",
                              "p_block_label": "1.1", "p_block_snippet": "VICTIM SECRET SNIPPET",
                              "p_block_text": "VICTIM SECRET HIGHLIGHT TEXT"})
        if st >= 300:
            raise RuntimeError(f"victim push_bookmark HTTP {st}: {body}")
        note(f"victim bookmarked synthetic doc {doc_id} with a private highlight")

        st, seen = http("GET", f"/rest/v1/synced_bookmarks_gated?select=id,user_id,block_text&id=eq.{doc_id}",
                        key=ANON, jwt=attacker["jwt"])
        check("BASELINE: attacker cannot SELECT the victim's bookmark", seen == [], str(seen))

        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=attacker["jwt"],
                        body={"id": f"xacct-item-ac-{secrets.token_hex(4)}",
                              "user_id": attacker["id"], "folder_id": f_a,
                              "item_type": "ac", "item_id": doc_id,
                              "added_at": now_iso(), "updated_at": now_iso(), "deleted": False},
                        headers={"Prefer": "return=representation"})
        check("attacker CAN point their own folder at a public document id", st < 300, f"HTTP {st}: {body}")

        st, seen = http("GET", f"/rest/v1/synced_bookmarks_gated?select=id,user_id,block_text&id=eq.{doc_id}",
                        key=ANON, jwt=attacker["jwt"])
        others = [r for r in (seen or []) if r["user_id"] != attacker["id"]]
        check("ATTACK: attacker still CANNOT read the victim's bookmark row",
              others == [], f"READ LEAK -- attacker got another user's row: {others}")
        if others:
            NOTES.append("CONFIRMED: synced_bookmarks_gated's folder-owner branch exposes "
                         "OTHER users' bookmark rows for any document id the attacker names")

        # Write half: `authenticated` holds no INSERT/UPDATE/DELETE grant on
        # synced_bookmarks at all (only REFERENCES/TRIGGER), so the equally
        # broad ALL policies on that table should be unreachable from a client.
        st, patched = http("PATCH", f"/rest/v1/synced_bookmarks?id=eq.{doc_id}", key=ANON,
                           jwt=attacker["jwt"],
                           body={"deleted": True, "updated_at": now_iso(3600)},
                           headers={"Prefer": "return=representation"})
        st2, truth = http("GET", f"/rest/v1/synced_bookmarks?select=deleted&id=eq.{doc_id}", key=SERVICE)
        check("attacker's direct UPDATE on synced_bookmarks does not delete the victim's bookmark "
              "(no table grant for `authenticated`)",
              bool(truth) and truth[0]["deleted"] is False, f"HTTP {st}: {patched} / row now {truth}")

        # ═══════════════ 3. guards that MUST hold ════════════════════════════
        print("\n--- 3. positive proof: the auth.uid()-scoped delete RPCs ---")
        st, body = http("POST", "/rest/v1/rpc/soft_delete_bookmarks", key=ANON, jwt=attacker["jwt"],
                        body={"p_ids": [doc_id]})
        st2, truth = http("GET", f"/rest/v1/synced_bookmarks?select=deleted&id=eq.{doc_id}", key=SERVICE)
        check("soft_delete_bookmarks called by the attacker leaves the victim's bookmark alive "
              "(WHERE user_id = auth.uid())",
              bool(truth) and truth[0]["deleted"] is False, f"row now {truth}")

        f_v = f"xacct-victim-folder-{victim['id']}"
        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=victim["jwt"],
                        body={"id": f_v, "user_id": victim["id"], "name": "Victim folder",
                              "created_at": now_iso(), "updated_at": now_iso()},
                        headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"victim folder insert HTTP {st}: {body}")
        http("POST", "/rest/v1/rpc/soft_delete_own_folder", key=ANON, jwt=attacker["jwt"],
             body={"p_id": f_v})
        st2, truth = http("GET", f"/rest/v1/synced_folders?select=deleted&id=eq.{f_v}", key=SERVICE)
        check("soft_delete_own_folder called by the attacker leaves the victim's folder alive "
              "(WHERE user_id = auth.uid())",
              bool(truth) and truth[0]["deleted"] is False, f"row now {truth}")

        st, patched = http("PATCH", f"/rest/v1/synced_folder_items?folder_id=eq.{f_v}", key=ANON,
                           jwt=attacker["jwt"], body={"deleted": True, "updated_at": now_iso(3600)},
                           headers={"Prefer": "return=representation"})
        check("attacker's unfiltered folder-item UPDATE cannot reach the victim's folder "
              "(the RLS syncPushFolderItemDeletes relies on)", patched == [], f"HTTP {st}: {patched}")

    finally:
        delete_user(victim["id"])
        delete_user(attacker["id"])
        note("both disposable accounts deleted (cascades remove every row above)")

    print("\n=== NOTES ===")
    for n in NOTES:
        print(f"  - {n}")
    print(f"\n=== {'FAILED' if FAILURES else 'ALL PASSED'} ({len(FAILURES)} failure(s)) ===")
    for f in FAILURES:
        print(f"  FAIL {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
