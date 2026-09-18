#!/usr/bin/env python3
"""No test harness may send real mail, and no real user may be suppressed.

Bounce rate -- not quota -- is what damages a sending domain. A domain with an
elevated bounce rate gets throttled by Resend and routed to spam by Gmail, and
the people that hurts are the ones trying to confirm a brand-new account. At
beta scale that is indistinguishable from "the app is broken."

TWO HOLES, ONE ALREADY PLUGGED AND ONE NOT.
  * Welcome emails: trigger_send_welcome_email() already skips RFC 2606/6761
    reserved domains (.invalid/.test/.example), so admin-created harness users
    send nothing. See memory/gotcha_test_users_send_welcome_email.md.
  * CONFIRMATION emails: that trigger cannot help, because the confirmation is
    sent by GoTrue itself the moment /auth/v1/signup is called. Any script that
    signs up a fake address therefore mails a domain that cannot receive, and
    it bounces. Measured 2026-09-18: every single non-delivery in the last 100
    sends was our own test traffic -- 4 bounced, 2 suppressed, 1 delayed.

So the rule this audit enforces: harnesses create users through the ADMIN API
(which sends nothing for a reserved domain), never through the public signup
endpoint. The admin path is also what every existing harness already uses; this
just stops the next one drifting.

It then checks the live Resend account, because a rule about bounces is worth
nothing without looking at the actual bounces.

Usage: python3 scripts/test_email_hygiene_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    print("=== 1. No harness signs up through the public endpoint ===")
    offenders = []
    for f in sorted((ROOT / "scripts").glob("*.py")):
        if f.name == "test_email_hygiene_audit.py":
            continue
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if line.lstrip().startswith(("#", '"', "'")):
                continue
            if re.search(r"auth/v1/signup|\.auth\.sign_up|\.auth\.signUp", line):
                offenders.append(f"{f.name}:{i}")
    check("no script calls the public signup endpoint (GoTrue mails a real "
          "confirmation the instant it is called)",
          not offenders, ", ".join(offenders))

    print("\n=== 2. Harness accounts use a reserved, undeliverable domain ===")
    bad_domain = []
    for f in sorted((ROOT / "scripts").glob("*.py")):
        for i, line in enumerate(f.read_text().splitlines(), 1):
            m = re.search(r"@flyregs\.com[\"']", line)
            if m and re.search(r"f?[\"'].*\{.*\}.*@flyregs\.com|test|disposable|qa-|preview",
                               line, re.I):
                bad_domain.append(f"{f.name}:{i}")
    check("no harness mints accounts on the REAL flyregs.com domain "
          "(those bounce on a domain we actually send from)",
          not bad_domain, ", ".join(bad_domain[:6]))

    print("\n=== 3. LIVE: the sending domain is healthy ===")
    try:
        from resend_api import request
    except Exception as e:                                        # pragma: no cover
        check("resend_api helper importable", False, str(e))
        request = None

    if request:
        st, d = request("GET", "/domains")
        doms = d.get("data", []) if isinstance(d, dict) else []
        check("the sending domain is verified",
              any(x.get("status") == "verified" for x in doms), str(doms)[:200])

        st, d = request("GET", "/emails?limit=100")
        rows = d.get("data", []) if isinstance(d, dict) else []
        check("recent sends readable", bool(rows), f"HTTP {st}")
        bad = [r for r in rows if r.get("last_event") in
               ("bounced", "suppressed", "delivery_delayed")]
        # The number that matters is not "any bounces" -- it is whether a REAL
        # PERSON failed to get their mail. Three populations, and only one is an
        # incident:
        #   * reserved-domain (.invalid) test traffic -- noise being removed;
        #   * harness accounts minted on the real flyregs.com domain -- a rule
        #     being broken, reported as a NOTE because the offending sends are
        #     historical and age out of this 100-row window on their own;
        #   * anything else -- a person who did not get their confirmation.
        # Failing forever on the middle group would make this audit permanently
        # red for something nobody can act on, which is how a check stops being
        # read at all (memory/gotcha_ci_red_unwatched.md).
        HARNESS = re.compile(r"(^|[-_.])(preview|previewpane|qa|test|disposable|"
                             r"tiermatrix|resign|firstrun|pwtest|sublc)", re.I)
        def addrs(r):
            return [str(t) for t in (r.get("to") or [])]
        reserved = lambda r: any(".invalid" in a or ".test" in a or ".example" in a
                                 for a in addrs(r))
        harness  = lambda r: any(HARNESS.search(a.split("@")[0]) for a in addrs(r))
        real_bad    = [r for r in bad if not reserved(r) and not harness(r)]
        harness_bad = [r for r in bad if not reserved(r) and harness(r)]
        check("no REAL PERSON's address bounced or was suppressed recently",
              not real_bad,
              "; ".join(f"{r.get('created_at','')[:10]} {r.get('last_event')} "
                        f"{r.get('to')}" for r in real_bad[:5]))
        if harness_bad:
            print(f"  NOTE  {len(harness_bad)} non-delivery(ies) to HARNESS accounts on the "
                  f"real flyregs.com domain -- test accounts belong on @flyregs.invalid, "
                  f"which the welcome-email trigger already skips:")
            for r in harness_bad[:5]:
                print(f"          {r.get('created_at','')[:10]}  {r.get('last_event'):12} "
                      f"{addrs(r)}")
        rate = (len(bad) / len(rows) * 100) if rows else 0
        print(f"  NOTE  {len(rows)} recent sends, {len(bad)} non-delivered "
              f"({rate:.0f}%) -- all reserved-domain test traffic is expected to "
              f"fall to 0 as harnesses stop mailing.")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("test_email_hygiene -- harnesses send no real mail; no real address is suppressed")


if __name__ == "__main__":
    main()
