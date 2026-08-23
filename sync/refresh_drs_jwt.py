#!/usr/bin/env python3
"""Auto-refresh the DRS_JWT/DRS_USER guest session used by loi_scraper.py.

Real problem this replaces (2026-08-23): DRS's guest JWT lives ~12 hours,
so the weekly LOI sync needed a human to manually re-capture it from
browser DevTools every time it lapsed -- RC, verbatim, after doing this
several times: "that's an unacceptable way to go about securing an
automated, reliable weekly scrape." An earlier investigation
(PROJECT_NOTES/flyregs_loi_build_spec.md, 2026-07-29) tried a handful of
plausible `/api/drs/auth/*` endpoint guesses via plain HTTP and all 403'd,
concluding "no proven way to auto-refresh" -- confirmed live 2026-08-23
that those specific bare-`requests` attempts still 403 the SAME way, but
for a different reason than assumed: DRS sits behind Akamai bot detection
(the `bm_sv` cookie), which a plain HTTP client can't pass regardless of
which endpoint it hits. A REAL browser engine can, though -- confirmed
live: loading https://drs.faa.gov/search in an actual browser (Claude's
own MCP browser tool, then independently re-confirmed with headless
Playwright/Chromium here) gets a fresh `jwt`+`user` cookie pair issued
automatically, zero login, zero manual capture, just from the page load
itself making its own normal search API calls.

This is the automated equivalent of that manual DevTools capture: launch
headless Chromium, load the search page, wait for it to make its own
real search calls (which is what triggers the cookie issuance), read the
resulting jwt/user cookies back out, and hand them to the caller. Fails
loudly (non-zero exit) if the cookies don't show up, rather than silently
producing an empty/stale token -- the same lesson loi_scraper.py's own
missing-credential fix already applied.

Usage:
    python3 refresh_drs_jwt.py                # prints DRS_JWT=...\nDRS_USER=... to stdout
    python3 refresh_drs_jwt.py --env-file PATH # also (over)writes/updates those two lines in PATH
"""
import argparse
import os
import re
import sys

from playwright.sync_api import sync_playwright

DRS_SEARCH_URL = "https://drs.faa.gov/search"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")


def fetch_fresh_session() -> tuple[str, str]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(user_agent=UA)
            page = context.new_page()
            page.goto(DRS_SEARCH_URL, wait_until="networkidle", timeout=30000)
            # networkidle already waits out the page's own search calls, but
            # give the cookie-setting response a moment to actually land --
            # cheap insurance, not load-bearing in testing so far.
            page.wait_for_timeout(1000)
            cookies = {c["name"]: c["value"] for c in context.cookies()}
        finally:
            browser.close()

    jwt = cookies.get("jwt")
    user = cookies.get("user")
    if not jwt or not user:
        raise RuntimeError(
            f"DRS did not issue a jwt/user cookie pair (got keys: {sorted(cookies.keys())}). "
            "The site's bot-detection or auth flow may have changed -- this needs "
            "re-investigation, not a retry loop."
        )
    return jwt, user


def update_env_file(path: str, jwt: str, user: str) -> None:
    if not os.path.exists(path):
        with open(path, "a") as f:
            f.write(f"export DRS_JWT={jwt}\nexport DRS_USER={user}\n")
        return
    with open(path) as f:
        lines = f.readlines()
    seen_jwt = seen_user = False
    out = []
    for line in lines:
        if re.match(r"^\s*(export\s+)?DRS_JWT=", line):
            out.append(f"export DRS_JWT={jwt}\n")
            seen_jwt = True
        elif re.match(r"^\s*(export\s+)?DRS_USER=", line):
            out.append(f"export DRS_USER={user}\n")
            seen_user = True
        else:
            out.append(line)
    if not seen_jwt:
        out.append(f"export DRS_JWT={jwt}\n")
    if not seen_user:
        out.append(f"export DRS_USER={user}\n")
    with open(path, "w") as f:
        f.writelines(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None, help="Also write/update DRS_JWT/DRS_USER lines in this file")
    args = ap.parse_args()

    jwt, user = fetch_fresh_session()
    print(f"export DRS_JWT={jwt}")
    print(f"export DRS_USER={user}")

    if args.env_file:
        update_env_file(args.env_file, jwt, user)
        print(f"# updated {args.env_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
