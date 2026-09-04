#!/usr/bin/env python3
"""What happens to a user's DATA and FEATURES when their tier drops.

WHY THIS EXISTS
---------------
tier_matrix_test.py proves every gated READ returns the right thing for a
given tier. It says nothing about the transition: a user who WAS Premium,
created Premium-only things, and then downgraded. RC's requirement:

    "we must test that Prem only features and data get wiped and do NOT
     carry with them. Duels, duel history, shared folders - both theirs and
     those they have been sent from others, offline info, etc."

Downgrade is the hard direction. Going UP is easy (keep everything, unlock
more). Going DOWN has two separate obligations, and passing one is not
passing the other:

    1. every higher-tier GATE closes            (can they still DO it?)
    2. higher-tier DATA does not follow them    (can they still SEE it?)

WHAT IT DOES
------------
Two disposable @flyregs.invalid accounts (A = subject, B = peer), both
Premium. A builds real Premium-only state -- several aircraft, folders, a
folder shared out to B, a folder shared IN from B, an offline download, a
duel against B. Then A is downgraded Premium -> Pro -> Free, and every
surface is re-probed at each step with A's own JWT against the real
endpoints.

Read-only against production DATA: every row it touches belongs to the two
throwaway users it creates, and both are deleted at the end (including on
failure). It never mutates a real account.

NOT a pass/fail suite -- it is a MATRIX. Several cells are judgement calls
that need RC's decision (does a downgraded user keep reading a download they
already saved?), so this prints what actually happens and flags the cells
where the app's behaviour and the stated intent disagree.

Usage: python3 scripts/downgrade_matrix_test.py
"""
import json, os, re, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")

# B's callsign, used by the "CAN invite to a folder" probe.
CALLSIGN_B = "DgTestB"
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}

TIERS = {
    "premium": {"is_pro": True,  "is_premium": True,  "is_unlocked": True},
    "pro":     {"is_pro": True,  "is_premium": False, "is_unlocked": True},
    "free":    {"is_pro": False, "is_premium": False, "is_unlocked": False},
}


def call(url, data=None, headers=None, method=None):
    r = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
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
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


def auth_headers(jwt):
    return {"apikey": ANON, "Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}


def rpc(jwt, fn, payload=None):
    return call(f"{URL}/rest/v1/rpc/{fn}", payload if payload is not None else {}, auth_headers(jwt))


def rest(jwt, path):
    return call(f"{URL}/rest/v1/{path}", headers=auth_headers(jwt))


def make_user(tag):
    email = f"dgtest-{tag}@flyregs.invalid"
    st, out = call(f"{URL}/auth/v1/admin/users",
                   {"email": email, "password": f"Fl!dg-{tag}-9137", "email_confirm": True}, SVC)
    if st in (200, 201):
        uid = out["id"]
    else:
        _, page = call(f"{URL}/auth/v1/admin/users?page=1&per_page=200", headers=SVC)
        uid = next(u["id"] for u in page["users"] if u["email"] == email)
    return uid, email


def set_tier(uid, tier):
    call(f"{URL}/rest/v1/user_entitlements",
         {"user_id": uid, **TIERS[tier], "updated_at": "2026-09-04T00:00:00Z"},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})


def jwt_for(email):
    _, link = call(f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email}, SVC)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    _, sess = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                   {"apikey": ANON, "Content-Type": "application/json"})
    return sess["access_token"]


def n(res):
    """Row count from a PostgREST list response, or an HTTP marker."""
    st, body = res
    if st != 200:
        return f"HTTP {st}"
    return len(body) if isinstance(body, list) else body


def truth(path):
    """Row count as the SERVICE key -- bypasses RLS entirely.

    This is the column that matters. A user-visible count dropping to 0 on
    downgrade is ambiguous on its own: it could be RLS correctly HIDING rows
    (reversible -- upgrade restores them) or the rows being DELETED (data
    loss, and unrecoverable). Those need opposite reactions, so the matrix
    prints both and never makes you guess which one you are looking at.
    """
    st, body = call(f"{URL}/rest/v1/{path}", headers=SVC)
    if st != 200:
        return f"HTTP {st}"
    return len(body) if isinstance(body, list) else body


def probe(jwt, uid_a, uid_b, folder_own, folder_from_b, folder_solo, ad_number):
    """Everything a downgraded user might still SEE or DO, in one snapshot."""
    p = {}

    # --- fleet: visible vs actually stored
    p["fleet visible (get_fleet_summary)"] = n(rpc(jwt, "get_fleet_summary"))
    p["aircraft VISIBLE to user"] = n(rest(jwt, "user_aircraft?select=id"))
    p["aircraft ROWS ON DISK *"] = truth(f"user_aircraft?select=id&user_id=eq.{uid_a}")
    st, body = rpc(jwt, "get_fleet_hidden_count")
    p["fleet hidden count"] = body if st == 200 else f"HTTP {st}"

    # --- folders
    p["owned folders (all)"] = n(rpc(jwt, "get_owned_folders_all"))
    p["folders VISIBLE to user"] = n(rest(jwt, "synced_folders?select=id"))
    p["folder ROWS ON DISK *"] = truth(f"synced_folders?select=id&user_id=eq.{uid_a}&deleted=eq.false")
    st, body = rpc(jwt, "has_visible_folder_access")
    p["has_visible_folder_access"] = body if st == 200 else f"HTTP {st}"

    # --- shared folders: one they own & shared out, one shared IN to them
    # NB: has_folder_access is COLLABORATOR access, so an owner is correctly
    # False here -- their own folder is reached through ownership, not this.
    # It requires BOTH sides to be Premium, which is the real revocation rule.
    p["collaborators still on MY folder *"] = truth(
        f"folder_collaborators?select=user_id&folder_id=eq.{folder_own}&left_at=is.null")
    st, body = rpc(jwt, "has_folder_access", {"p_folder_id": folder_from_b, "p_require_editor": False})
    p["can read folder shared TO them"] = body if st == 200 else f"HTTP {st}"
    p["items in folder shared TO them"] = n(
        rest(jwt, f"synced_folder_items?select=id&folder_id=eq.{folder_from_b}"))

    # --- offline downloads
    p["downloads VISIBLE to user"] = n(rest(jwt, "user_offline_downloads?select=item_id"))
    p["download ROWS ON DISK *"] = truth(f"user_offline_downloads?select=item_id&user_id=eq.{uid_a}")
    # The "CAN do X" probes are WRITES, so they have to undo themselves --
    # otherwise the probe pollutes the very counts above it and the matrix
    # reports its own side effects as unrestored data. (First version did
    # exactly that: four rows flagged NOT RESTORED that were really just the
    # probe's own rows.)
    st, _ = rpc(jwt, "record_offline_download", {"p_item_type": "ad", "p_item_id": ad_number})
    p["CAN record a new download"] = "yes" if st in (200, 204) else f"blocked ({st})"
    if st in (200, 204):
        rpc(jwt, "remove_offline_download", {"p_item_type": "ad", "p_item_id": ad_number})

    # --- duels
    p["duels visible (get_my_challenges)"] = n(rpc(jwt, "get_my_challenges"))
    p["duel PARTICIPANT ROWS ON DISK *"] = truth(
        f"challenge_participants?select=challenge_id&user_id=eq.{uid_a}")
    st, body = rpc(jwt, "get_duel_stats")
    p["duel stats readable"] = ("yes" if body else "empty") if st == 200 else f"HTTP {st}"
    p["challengeable users"] = n(rpc(jwt, "get_challengeable_users"))
    st, body = rpc(jwt, "create_challenge",
                   {"p_opponent_ids": [uid_b], "p_question_count": 5, "p_item_types": ["far"]})
    p["CAN create a duel"] = "yes" if st in (200, 201) else f"blocked ({st})"
    if st in (200, 201) and isinstance(body, str):
        # create_challenge RETURNS uuid, so the body is the id itself.
        #
        # cancel_challenge is NOT enough here: cancelling correctly KEEPS the
        # row (a cancelled duel stays in your history), so the participant
        # count would still carry the probe's duel and the matrix would report
        # its own artifact as unrestored data. This is a test fixture, so
        # remove it outright with the service key -- the cascade takes the
        # challenge_participants rows with it.
        call(f"{URL}/rest/v1/challenges?id=eq.{body}", None, SVC, "DELETE")

    # --- sharing invites
    inv_token = f"probe-{int(time.time() * 1000)}"
    st, inv_body = rpc(jwt, "invite_folder_collaborator",
                       {"p_folder_id": folder_solo, "p_callsign": CALLSIGN_B,
                        "p_token": inv_token})
    if st in (200, 204):
        # Self-undoing, like the duel probe above: a left-behind invite would
        # show up as a collaborator row on the next tier's count.
        call(f"{URL}/rest/v1/folder_collaborators?invite_token=eq.{inv_token}",
             None, SVC, "DELETE")
    p["CAN invite to a folder"] = "yes" if st in (200, 204) else f"blocked ({st})"
    if st not in (200, 204) and os.environ.get("DG_DEBUG"):
        print(f"    [debug] invite -> {st} {inv_body}")
    return p


def main():
    print("Building two disposable Premium accounts...")
    uid_a, email_a = make_user("a")
    uid_b, email_b = make_user("b")
    created = [uid_a, uid_b]
    try:
        for u in created:
            set_tier(u, "premium")
        jwt_a, jwt_b = jwt_for(email_a), jwt_for(email_b)
        folder_own = f"dgf-own-{int(time.time())}"
        folder_from_b = f"dgf-fromb-{int(time.time())}"
        # A third folder A owns that B has NOT joined. The invite probe needs
        # one: aiming it at folder_own returned "already has access" -- a
        # legitimate refusal, but it fires BEFORE the Premium check, so the
        # cell read "blocked" at Premium too and proved nothing.
        folder_solo = f"dgf-solo-{int(time.time())}"

        # --- A builds real Premium-only state -------------------------------
        # Seeded through the REAL user path (A's own JWT), not the service key.
        # Two reasons, and the first cost me a run: the fleet-cap trigger reads
        # `auth.uid()`, and fleet_visible_cap() starts `when auth.uid() is null
        # then 0` -- so a service-role insert is always "Aircraft limit reached
        # for your current plan" no matter what the entitlement row says. The
        # second reason is better: this is what the app actually does, so the
        # fixture exercises the same gates the user hits.
        #
        # Every write is CHECKED. The first version of this script silently
        # created nothing and the matrix dutifully measured an empty account --
        # every Premium row read 0 and looked like a clean downgrade. A test
        # whose fixture fails quietly is worse than no test: it reports success.
        def as_user(jwt, table, row, what):
            st, body = call(f"{URL}/rest/v1/{table}", row,
                            {**auth_headers(jwt), "Prefer": "return=representation"})
            if st not in (200, 201):
                raise SystemExit(f"SEED FAILED ({what}): HTTP {st} {str(body)[:200]}")
            return body

        def as_rpc(jwt, fn, payload, what, soft=False):
            st, body = rpc(jwt, fn, payload)
            if st not in (200, 201, 204):
                msg = f"SEED {'WARN' if soft else 'FAILED'} ({what}): HTTP {st} {str(body)[:180]}"
                if soft:
                    print("  " + msg)
                    return None
                raise SystemExit(msg)
            return body

        # 3 aircraft. Pro's visible cap is 1, so 2 must become hidden -- not
        # deleted -- on downgrade.
        for tail in ["N101DG", "N202DG", "N303DG"]:
            as_user(jwt_a, "user_aircraft",
                    {"user_id": uid_a, "make": "Cessna", "model": "172",
                     "nickname": tail, "type_designator": "C172"}, f"aircraft {tail}")

        # Two folders, each shared to the other user via the real join-by-token
        # flow (join_shared_folder is itself Premium-gated, so this also proves
        # the fixture ran while both accounts really were Premium).
        tok_own, tok_from_b = f"tokA{int(time.time())}", f"tokB{int(time.time())}"
        for fid, jwt, owner, name, tok in [
            (folder_own, jwt_a, uid_a, "A's shared folder", tok_own),
            (folder_from_b, jwt_b, uid_b, "B's folder shared to A", tok_from_b),
            (folder_solo, jwt_a, uid_a, "A's un-shared folder", f"tokS{int(time.time())}"),
        ]:
            as_user(jwt, "synced_folders",
                    {"id": fid, "user_id": owner, "name": name, "share_token": tok,
                     "created_at": "2026-09-04T00:00:00Z", "updated_at": "2026-09-04T00:00:00Z"},
                    f"folder {name}")
            as_user(jwt, "synced_folder_items",
                    {"id": f"{fid}-item", "user_id": owner, "folder_id": fid,
                     "item_type": "far", "item_id": "91.155",
                     "added_at": "2026-09-04T00:00:00Z", "updated_at": "2026-09-04T00:00:00Z"},
                    f"item in {name}")
        as_rpc(jwt_b, "join_shared_folder", {"p_token": tok_own}, "B joins A's folder")
        as_rpc(jwt_a, "join_shared_folder", {"p_token": tok_from_b}, "A joins B's folder")

        # Duels need both pilots opted in to the leaderboard -- get_challengeable_users
        # filters on user_streaks.leaderboard_opt_in, so without this the duel
        # fixture fails with "That pilot hasn't enabled Duel challenges yet"
        # and every duel row in the matrix reads 0 for the wrong reason.
        for u in (uid_a, uid_b):
            call(f"{URL}/rest/v1/user_streaks",
                 {"user_id": u, "leaderboard_opt_in": True},
                 {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})

        # B needs a real callsign, or the "CAN invite to a folder" probe fails
        # with "no such pilot" at EVERY tier -- blocked/blocked/blocked/blocked,
        # including at Premium, which tells us nothing about the gate. Set it
        # through set_callsign (Account > Callsign) rather than inserting the
        # row: that RPC owns callsign_lower's normalization, which is what
        # lookup_user_by_callsign matches on.
        as_rpc(jwt_b, "set_callsign", {"p_callsign": CALLSIGN_B}, "B's callsign")

        as_rpc(jwt_a, "record_offline_download",
               {"p_item_type": "far", "p_item_id": "91.155"}, "offline download")
        as_rpc(jwt_a, "create_challenge",
               {"p_opponent_ids": [uid_b], "p_question_count": 5, "p_item_types": ["far"]},
               "duel vs B", soft=True)
        print("  seeded: 3 aircraft, 2 folders (1 shared out / 1 shared in), 1 download, 1 duel")

        # --- probe at each tier ---------------------------------------------
        # premium -> pro -> free, then BACK to premium. That last step is the
        # one that matters most: the whole design is "hide, don't delete", and
        # the only way to know hiding was really hiding is to put the tier back
        # and see the data return. RC: "moving up, you of course must keep
        # any/all data, and then get to build on it with the new features."
        snaps = {}
        for tier in ["premium", "pro", "free", "premium_again"]:
            set_tier(uid_a, "premium" if tier == "premium_again" else tier)
            time.sleep(1)
            jwt_a = jwt_for(email_a)   # fresh JWT so no stale claim is in play
            snaps[tier] = probe(jwt_a, uid_a, uid_b, folder_own, folder_from_b, folder_solo,
                                "2024-25-51")

        keys = list(snaps["premium"].keys())
        w = max(len(k) for k in keys) + 2
        print()
        print("=" * (w + 56))
        print(f"{'surface':<{w}}{'PREMIUM':>13}{'-> PRO':>13}{'-> FREE':>13}{'-> PREMIUM':>14}")
        print("=" * (w + 56))
        not_restored = []
        for k in keys:
            row = [str(snaps[t][k]) for t in ["premium", "pro", "free", "premium_again"]]
            changed = not (row[0] == row[1] == row[2])
            restored = row[3] == row[0]
            flag = ""
            if changed and not restored:
                flag = "   <-- NOT RESTORED"
                not_restored.append(k)
            elif changed:
                flag = "   <-- hidden, restored"
            print(f"{k:<{w}}{row[0]:>13}{row[1]:>13}{row[2]:>13}{row[3]:>14}{flag}")
        print("=" * (w + 56))
        print("\n'hidden, restored' = the gate closed on the way down and the data came")
        print("back on the way up. That is the design working.")
        if not_restored:
            print(f"\nNOT RESTORED after re-upgrade ({len(not_restored)}):")
            for k in not_restored:
                print(f"  - {k}")
            print("Each needs a look: either the data really was destroyed, or the probe")
            print("itself moved the number (e.g. it creates a row as a side effect).")
        else:
            print("\nEverything hidden on the way down came back on the way up.")
    finally:
        print("\nCleaning up test accounts...")
        for u in created:
            call(f"{URL}/auth/v1/admin/users/{u}", headers=SVC, method="DELETE")
        print("  done")


if __name__ == "__main__":
    main()
