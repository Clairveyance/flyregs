#!/usr/bin/env python3
"""The app's shareable types and the website's must agree, exactly.

A shared reg link goes to flyregs.com/reg/?type=...&id=..., and that page
decides two things from `type`: the title in the iMessage bubble, and whether
to attempt the flyregs://<type>/<id> deep link at all. A type the APP can build
a link for but the WEBSITE does not know is not a soft degradation -- the page
bails before ever attempting the hand-off, so a recipient WITH FlyRegs
installed still never lands in the app. The link looks fine to the sender and
quietly fails for the receiver.

This exact pair has already drifted three times:
  * 'loi'        -- shipped app-side on all 1,055 LOI detail screens while the
                    website still had only the original four
  * 'dictionary' -- reached the site via an unchecked `as RegShareType` cast
  * 'cfr49'      -- the reverse: deliberately withheld app-side BECAUSE the
                    website list had not been updated, leaving 49 CFR as the
                    one reader screen with no Share button (2026-09-18)

Both files carry a "MUST stay in sync" comment pointing at each other. Comments
do not stay in sync; this does.

Usage: python3 scripts/share_types_in_sync_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT.parent / "01_Website/flyregs-website/reg/index.php"
APP = ROOT / "src/lib/regShare.ts"
FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    if not SITE.exists():
        print(f"SKIP  website source not present at {SITE}")
        return
    site = SITE.read_text()
    app = APP.read_text()

    m = re.search(r"export type RegShareType\s*=\s*([^\n]+)", app)
    app_types = set(re.findall(r"'([a-z0-9]+)'", m.group(1))) if m else set()

    m = re.search(r"\$TYPE_NAMES\s*=\s*array\((.*?)\);", site, re.S)
    site_names = set(re.findall(r"'([a-z0-9]+)'\s*=>", m.group(1))) if m else set()

    m = re.search(r"var VALID_TYPES\s*=\s*\[(.*?)\]", site, re.S)
    site_valid = set(re.findall(r"'([a-z0-9]+)'", m.group(1))) if m else set()

    print(f"  app RegShareType : {sorted(app_types)}")
    print(f"  site TYPE_NAMES  : {sorted(site_names)}")
    print(f"  site VALID_TYPES : {sorted(site_valid)}\n")

    check("the app builds links only for types the website titles",
          app_types <= site_names, f"app-only: {sorted(app_types - site_names)}")
    check("the app builds links only for types the website will deep-link",
          app_types <= site_valid, f"app-only: {sorted(app_types - site_valid)}")
    check("the website's two lists agree with each other",
          site_names == site_valid,
          f"TYPE_NAMES-only: {sorted(site_names - site_valid)}, "
          f"VALID_TYPES-only: {sorted(site_valid - site_names)}")

    # A reader screen that exists but cannot be shared is the shape that left
    # 49 CFR out -- flagged, not failed, because 'ac' shares by its own route
    # and 'dictionary' shares from Saved rather than a detail screen.
    readers = {p.parent.name for p in (ROOT / "src/app").glob("*/[[]*.tsx")
               if p.parent.name in
               ("far", "aim", "ac", "ad", "loi", "pcg", "cfr49", "dictionary")}
    unshareable = readers - app_types - {"ac"}
    if unshareable:
        print(f"  NOTE  reader screens with no generic share type: {sorted(unshareable)} "
              f"(fine only if each has its own share route)")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("share_types_in_sync -- the app and the website agree on every shareable type")


if __name__ == "__main__":
    main()
