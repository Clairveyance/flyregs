#!/usr/bin/env python3
"""The prices the paywall shows offline must be the prices Apple charges.

paywall.tsx renders FALLBACK_PRICING immediately and only upgrades it if
RevenueCat's live offerings resolve in time -- deliberately, so the purchase
screen never opens on a blank price. That is the right design, and it creates
exactly one hazard: those hardcoded numbers are a SECOND copy of the price, and
the App Store is the first. Change a price in App Store Connect and the app
keeps advertising the old one to anyone whose offerings fetch is slow, offline,
or not yet configured -- a wrong price on the purchase screen, which is the one
number a customer is entitled to have right.

Nothing connected the two until now. Checked live against App Store Connect,
which this project has had an API helper for all along.

HOW THE PRICE IS ACTUALLY READ, because it is not obvious and cost a wrong
alarm on the first attempt:
  * /v1/subscriptions/{id}/prices returns EVERY territory, ordered by territory
    code -- so the first row is ARE (UAE), not USA. Reading row one and
    comparing it to a USD fallback reports a 4x discrepancy that does not
    exist. Filter on territory explicitly.
  * A one-time IAP's set price is not in /pricePoints (that is the catalogue of
    AVAILABLE prices, which starts at $0.00). It is in /iapPriceSchedule, whose
    manualPrices id is base64 JSON -- {"t":"USA","p":"10167"} -- and that `p`
    has to be looked up against the price-point catalogue to get a number.

Usage: python3 scripts/paywall_price_matches_appstore_audit.py
"""
import base64
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GROUP = "22198282"
APP_ID = "6785706782"
FAILURES = []


def asc(path):
    out = subprocess.run([sys.executable, str(ROOT / "scripts/asc_api.py"), "GET", path],
                         capture_output=True, text=True).stdout
    try:
        return json.loads(out.split("\n", 1)[1])
    except Exception:
        return {}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def fallback_prices():
    src = (ROOT / "src/app/paywall.tsx").read_text()
    blk = re.search(r"const FALLBACK_PRICING = \{(.*?)\n\}", src, re.S).group(1)
    grab = lambda k: re.search(rf"{k}:\s*'\$([\d.]+)'", blk)
    out = {}
    for tier in ("pro", "premium"):
        row = re.search(rf"{tier}:\s*\{{([^}}]*)\}}", blk).group(1)
        for per in ("monthly", "annual"):
            m = re.search(rf"{per}:\s*'\$([\d.]+)'", row)
            if m:
                out[f"{tier}_{per}"] = m.group(1)
    m = re.search(r"plus:\s*\{[^}]*oneTime:\s*'\$([\d.]+)'", blk)
    if m:
        out["plus_oneTime"] = m.group(1)
    return out


def main():
    fb = fallback_prices()
    print(f"  paywall FALLBACK_PRICING: {fb}\n")

    subs = asc(f"/v1/subscriptionGroups/{GROUP}/subscriptions?limit=20").get("data", [])
    check("all four subscription products exist in App Store Connect",
          len(subs) == 4, f"found {len(subs)}")

    for s in subs:
        pid = s["attributes"]["productId"]
        key = pid.rsplit(".", 1)[1]                      # e.g. premium_annual
        # Territory filter is load-bearing -- see this file's header.
        d = asc(f"/v1/subscriptions/{s['id']}/prices"
                f"?include=subscriptionPricePoint&filter%5Bterritory%5D=USA&limit=5")
        inc = {i["id"]: i for i in d.get("included", [])}
        live = None
        for p in d.get("data", []):
            pp = (p.get("relationships", {}).get("subscriptionPricePoint", {}) or {}).get("data")
            if pp and pp["id"] in inc:
                live = inc[pp["id"]]["attributes"].get("customerPrice")
                break
        want = fb.get(key)
        check(f"{pid} — App Store USA price matches the paywall's offline fallback",
              want is not None and live is not None and float(live) == float(want),
              f"App Store ${live} vs paywall ${want}")

    iaps = asc(f"/v1/apps/{APP_ID}/inAppPurchasesV2?limit=10").get("data", [])
    for i in iaps:
        sched = asc(f"/v2/inAppPurchases/{i['id']}/iapPriceSchedule?include=manualPrices")
        ids = [x["id"] for x in
               (sched.get("data", {}).get("relationships", {})
                .get("manualPrices", {}).get("data", []) or [])]
        target = None
        for pid_b64 in ids:
            s = pid_b64 + "=" * (-len(pid_b64) % 4)
            try:
                j = json.loads(base64.b64decode(s))
            except Exception:
                continue
            if j.get("t") == "USA":
                target = j.get("p")
        live = None
        url = f"/v2/inAppPurchases/{i['id']}/pricePoints?filter%5Bterritory%5D=USA&limit=200"
        scanned = 0
        while url and target and live is None and scanned < 1200:
            d = asc(url)
            for r in d.get("data", []):
                scanned += 1
                b = r["id"] + "=" * (-len(r["id"]) % 4)
                try:
                    if json.loads(base64.b64decode(b)).get("p") == target:
                        live = r["attributes"].get("customerPrice")
                        break
                except Exception:
                    pass
            nxt = d.get("links", {}).get("next")
            url = re.sub(r"^https://api\.appstoreconnect\.apple\.com(/v\d)?", "", nxt) if nxt and live is None else None
        want = fb.get("plus_oneTime")
        check(f"{i['attributes']['productId']} — App Store USA price matches the "
              f"paywall's offline fallback",
              want is not None and live is not None and float(live) == float(want),
              f"App Store ${live} vs paywall ${want}")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("paywall_price_matches_appstore -- every offline fallback price is the "
          "price Apple charges")


if __name__ == "__main__":
    main()
