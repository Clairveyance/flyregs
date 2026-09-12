#!/usr/bin/env python3
"""The invite search must predict the duel gate exactly, and must never enumerate.

WHY THIS EXISTS
Two separate defects, both in the same function, both silent.

1. A PREDICTION THAT DISAGREED WITH THE GATE IT PREDICTED.
   find_users_for_invite returns `duel_ready` so the invite list can grey out
   someone the server will refuse. The first version computed it as

       duel_notifications_enabled AND has_pro_access(u.id)

   while create_challenge's actual gate is

       user_streaks.leaderboard_opt_in AND user_entitlements.is_premium

   Neither half matched. duel_notifications_enabled is a PUSH preference -- a
   player with duel pushes off is perfectly duellable, they just find out when
   they open the app -- and has_pro_access() is `is_pro OR is_premium`, while
   Duels are Premium-only. It was wrong in both directions at once: RC's own
   account (Premium, opted in, no duel-push row) showed as NOT duel-ready in
   everyone else's invite list, and a Pro-only user would have shown as ready
   and then been rejected by create_challenge after being added.

   A wrong prediction is worse than no prediction: it denies invites the server
   would have accepted, and promises ones it will refuse. So this audit does
   not read the SQL for a matching expression -- expressions drift and can be
   rewritten a dozen equivalent ways. It runs the RPC against EVERY real user
   and compares the answer to the gate computed independently from the base
   tables. Any disagreement, on any real row, fails.

2. AN ENUMERATION ORACLE.
   Email and phone must be EXACT-match only. A prefix or substring search over
   either turns one lookup into a sweep of the userbase: feed it "a", then "b",
   and it hands back everyone. (Same reasoning as
   gotcha_public_bucket_select_policy_enables_enumeration.md.) A callsign is a
   public handle -- already shown in Ready Room and on every duel -- so prefix
   on THAT discloses nothing new and stays allowed.

   This audit proves the negative directly: it takes a real user's real email
   and phone, derives strings that a prefix/substring/domain search WOULD
   match, and fails if any of them returns that user.

KNOWN LIMIT, stated rather than papered over: both checks run against live
data, so they are only as strong as the userbase is varied. Part 1 is exact
for every user that exists; it cannot speak for a tier combination nobody
currently has. Part 2 does not need variety -- one real user with an email and
a phone is enough to prove the match is exact.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent


def mgmt(sql):
    r = subprocess.run(
        ["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
        capture_output=True, text=True, cwd=str(BASE),
    )
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def as_user(user_id, sql):
    """Run sql with auth.uid() = user_id, the way the app calls it."""
    claims = json.dumps({"sub": user_id, "role": "authenticated"}).replace("'", "''")
    return mgmt(
        "set local role authenticated;\n"
        f"set local request.jwt.claims = '{claims}';\n" + sql
    )


def main():
    failures, inert = [], []

    # A Premium, opted-in searcher -- find_users_for_invite requires Pro access
    # to call at all, so the audit must run as someone who has it.
    searchers = mgmt("""
      select u.id from auth.users u
      join user_entitlements ue on ue.user_id = u.id
      where ue.is_premium = true limit 1
    """)
    if not searchers:
        print("SKIP invite_search_audit -- no Premium account to search as")
        return 0
    me = searchers[0]["id"]

    # ---- Part 1: duel_ready must equal create_challenge's real gate ----------
    # Every findable user, with the gate computed from the BASE TABLES, not
    # from find_users_for_invite's own expression.
    truth = mgmt("""
      select u.id, cr.callsign,
             (coalesce(us.leaderboard_opt_in,false)
              and exists (select 1 from user_entitlements ue
                          where ue.user_id = u.id and ue.is_premium = true)) as gate
      from auth.users u
      join user_streaks us on us.user_id = u.id
      left join callsign_registry cr on cr.user_id = u.id
      where us.leaderboard_opt_in = true and cr.callsign is not null
    """)
    checked = 0
    for row in truth:
        if row["id"] == me:
            continue  # the RPC excludes the searcher themselves, by design
        cs = row["callsign"].replace("'", "''")
        got = as_user(me, f"select callsign, duel_ready from public.find_users_for_invite('{cs}');")
        hit = next((g for g in got if (g["callsign"] or "") == row["callsign"]), None)
        if hit is None:
            failures.append(
                f"{row['callsign']}: opted in with a callsign, but an exact "
                f"callsign search does not return them"
            )
            continue
        checked += 1
        if bool(hit["duel_ready"]) != bool(row["gate"]):
            failures.append(
                f"{row['callsign']}: duel_ready={hit['duel_ready']} but "
                f"create_challenge's gate says {row['gate']} -- the invite list "
                f"would {'refuse' if row['gate'] else 'offer'} an invite the "
                f"server would {'accept' if row['gate'] else 'reject'}"
            )

    # ---- Part 2: email and phone are exact-match only -----------------------
    probe = mgmt("""
      select u.id, u.email,
             public.normalize_phone(u.raw_user_meta_data->>'phone_number') as phone
      from auth.users u
      join user_streaks us on us.user_id = u.id
      where us.leaderboard_opt_in = true
        and u.id <> '%s'
        and u.email is not null
        and length(public.normalize_phone(u.raw_user_meta_data->>'phone_number')) >= 10
      order by u.id
      limit 1
    """ % me)
    if not probe:
        failures.append(
            "no opted-in user has both an email and a phone, so the "
            "enumeration half could not be exercised -- this check must not "
            "be allowed to pass vacuously"
        )
    else:
        p = probe[0]
        local, _, domain = p["email"].partition("@")
        phone = p["phone"]
        # Each string here is one a BROKEN implementation would match and a
        # correct exact-match one must not. The first version of this audit
        # passed vacuously because every "email" probe it built had had its
        # '@' truncated away, so the RPC classified them as callsign searches
        # and never exercised the email branch at all. Every email probe below
        # deliberately KEEPS an '@', so it is genuinely routed to email.
        sweeps = {
            # catches  lower(email) like q || '%'
            "email prefix (real local part, partial domain)":
                local + "@" + domain[: max(1, len(domain) // 2)],
            # catches  lower(email) like '%' || q
            "email suffix (partial local part, real domain)":
                local[len(local) // 2:] + "@" + domain,
            # catches  lower(email) like '%' || q || '%'  -- domain harvesting
            "bare domain": "@" + domain,
            # catches a phone prefix match
            "phone, last digit dropped": phone[:-1],
            # catches a phone substring match
            "phone, first and last digits dropped": phone[1:-1],
            "email local part with no domain at all": local,
        }
        for label, q in sweeps.items():
            q_esc = q.replace("'", "''")
            # Never trust a probe blindly: confirm it really IS a different
            # identifier before concluding anything from it not matching. A
            # phone written another way (555-867-5309 vs 15558675309) is the
            # SAME number after normalize_phone and is supposed to match, and
            # a probe like that would make this check silently meaningless.
            same = mgmt(
                "select lower('%s') = lower('%s') as same_email, "
                "       public.normalize_phone('%s') = public.normalize_phone('%s') "
                "         and length(public.normalize_phone('%s')) >= 10 as same_phone"
                % (q_esc, p["email"].replace("'", "''"), q_esc, phone, q_esc)
            )[0]
            if same["same_email"] or same["same_phone"]:
                failures.append(
                    f"probe {label!r} ({q!r}) is the same identifier as the "
                    f"user's own, so it proves nothing -- fix the probe"
                )
                continue
            # A probe that a broken implementation could not have matched
            # either proves nothing. Say so out loud rather than counting it
            # as a pass -- the first version of this audit reported six clean
            # probes when four of them never reached the branch they targeted.
            if label.startswith("phone"):
                norm = mgmt("select public.normalize_phone('%s') as n" % q_esc)[0]["n"]
                if not (phone.startswith(norm) and norm != phone):
                    inert.append(
                        f"{label}: {q!r} normalizes to {norm!r}, which is not a "
                        f"prefix of the stored {phone!r} -- normalize_phone pads "
                        f"a bare 10-digit query to 11, so no shorter query can "
                        f"reach the phone branch at all. A prefix bug is "
                        f"unreachable for an 11-digit US number; it would NOT be "
                        f"for a longer international one."
                    )
                    continue
            got = as_user(me, f"select user_id from public.find_users_for_invite('{q_esc}');")
            if any(g["user_id"] == p["id"] for g in got):
                failures.append(
                    f"ENUMERATION: a {label} search ({q!r}) returned the user -- "
                    f"email and phone must be exact-match only"
                )

    for n in inert:
        print("  NOTE not exercised -- " + n)
    if failures:
        print("FAIL invite_search_audit")
        for f in failures:
            print("  - " + f)
        return 1
    print(f"PASS invite_search_audit -- duel_ready matches create_challenge's gate "
          f"for all {checked} findable users; no prefix/substring/domain search "
          f"returns a user by email"
          + ("" if not inert else " (phone probes inert, see NOTE above)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
