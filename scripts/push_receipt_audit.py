#!/usr/bin/env python3
"""A push sender must find out whether the push was DELIVERED.

WHY THIS EXISTS
RC, over weeks: notifications don't arrive, and each time he was told it was
fixed. That claim could never be checked, because nothing in the system knew.
Every sender did this and stopped:

    POST /push/send   ->   if (ticket.status === 'error') console.error(...)
    console.log('Done.')

An Expo TICKET means "Expo accepted this". Whether APNs took it is a separate
answer, returned later as a RECEIPT that has to be fetched by ticket id. No
sender fetched one. A revoked token (DeviceNotRegistered), a credentials fault
(InvalidCredentials / MismatchSenderId, which breaks EVERY push at once) and a
perfectly delivered message all produced the same output: "Done."

So the pipeline could not tell delivered from discarded, and neither could
anyone reading its logs. This check makes that state impossible to reintroduce.

WHAT THIS CHECKS
Any file that POSTs to Expo's push/send endpoint must also reach the receipts
path -- either by going through scripts/lib/expo-push.mjs, or by calling
getReceipts itself. Sending without ever asking what happened is the defect.

KNOWN LIMIT, stated rather than papered over: this proves the receipts call is
WIRED, not that its verdict is acted on correctly. Per-sender bookkeeping (does
a failed receipt hold the reminder back for retry? does one dead handset
wrongly mark a multi-device user un-notified?) is logic this cannot see, and is
covered by each sender's own comments and tests.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SEND_RE = re.compile(r"push/send")
RECEIPT_RE = re.compile(r"getReceipts|expo-push\.mjs|checkExpoReceipts|sendExpoPush")

# The helper itself legitimately contains the raw endpoint -- it IS the
# implementation both halves live in.
HELPER = "scripts/lib/expo-push.mjs"


def main():
    senders, offenders = [], []
    for path in sorted(BASE.rglob("*.mjs")):
        if "node_modules" in path.parts or "build" in path.parts:
            continue
        rel = path.relative_to(BASE).as_posix()
        text = path.read_text()
        if not SEND_RE.search(text):
            continue
        senders.append(rel)
        if rel == HELPER:
            continue
        if not RECEIPT_RE.search(text):
            offenders.append(rel)

    # Edge functions send push too; check them the same way.
    for path in sorted((BASE / "supabase" / "functions").rglob("*.ts")) if (BASE / "supabase" / "functions").exists() else []:
        rel = path.relative_to(BASE).as_posix()
        text = path.read_text()
        if not SEND_RE.search(text):
            continue
        senders.append(rel)
        if not RECEIPT_RE.search(text):
            offenders.append(rel)

    print("=== files that send Expo pushes ===")
    print(f"  {len(senders)} sender(s), {len(offenders)} that never check delivery")
    print()
    if offenders:
        print("FAIL: these send a push and never find out whether it arrived --")
        for rel in offenders:
            print(f"  {rel}")
        print()
        print("  Route the send through scripts/lib/expo-push.mjs (sendExpoPush),")
        print("  or keep your own bookkeeping and call checkExpoReceipts() on the")
        print("  ticket ids. A ticket is not a delivery.")
        sys.exit(1)

    for rel in senders:
        print(f"  ok  {rel}")
    print()
    print("Every push sender verifies delivery against Expo's receipts.")
    sys.exit(0)


if __name__ == "__main__":
    main()
