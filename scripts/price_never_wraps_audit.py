#!/usr/bin/env python3
"""A price must never wrap.

Found 2026-09-18 on the iPhone 13 mini simulator, at the largest text size the
app offers: the Premium annual price rendered as

    $24.9
    9
    /yr

on the purchase screen itself. Not a crash, not an error -- just a number that
looks wrong on the one screen where a number that looks wrong costs money.

WHY IT SURVIVED EVERYTHING ELSE.  fs() scales type up to 1.75x, and nothing
about the paywall is broken at the default size. modal_card_bounded_audit.py
already encodes the lesson -- "never judge fit from a default-size screenshot"
-- but it checks whether a CARD is bounded, not whether the TEXT inside one
stays on a line. A price is the case where reflowing is not a graceful
degradation: "$24.9" is a different number.

THE RULE: a short string whose meaning depends on staying whole -- a price, a
period like "/yr" -- gets numberOfLines={1} and adjustsFontSizeToFit, so it
shrinks to fit rather than breaking. Long prose is the opposite and should
wrap freely; this audit deliberately only looks at prices.

Source-level, no network. Fails if a paywall Text renders a `pricing.` value
without being pinned to one line.

Usage: python3 scripts/price_never_wraps_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    src = ROOT / "src/app/paywall.tsx"
    text = src.read_text()

    # Every <Text ...>{...}</Text> in the file, with its attributes and body.
    blocks = re.findall(r"<Text\b(.*?)>(.*?)</Text>", text, re.S)
    checked = 0
    for attrs, body in blocks:
        renders_price = (
            "pricing." in body
            or re.search(r"\{\s*price\s*\}", body)
            or re.search(r"\{\s*period\s*\}", body)
        )
        if not renders_price:
            continue
        checked += 1
        label = (re.sub(r"\s+", " ", body).strip() or "?")[:48]
        pinned = "numberOfLines" in attrs
        shrinks = "adjustsFontSizeToFit" in attrs
        check(f"price/period Text `{label}` is pinned to one line", pinned,
              "add numberOfLines={1}")
        check(f"...and shrinks rather than truncating: `{label}`", shrinks,
              "add adjustsFontSizeToFit")

    check("the audit actually found price Texts to check (it has not been "
          "silently disarmed by a refactor)", checked >= 3, f"found {checked}")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print(f"price_never_wraps_audit -- {checked} price/period Text(s), none can wrap")


if __name__ == "__main__":
    main()
