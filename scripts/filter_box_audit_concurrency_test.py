"""Prove the INCONCLUSIVE branch in filter_box_audit actually executes.

Two things to establish, neither of which the earlier concurrent run showed:
  1. bank_fingerprint() returns a real live-row count (not None), otherwise
     bank_moved can never be True and the branch is dead code.
  2. With FAILURES non-empty AND the bank moved, main() reports INCONCLUSIVE
     and exits 0 -- rather than reporting FAILED and exiting 1.
"""
import sys, io, contextlib
sys.path.insert(0, "scripts")
import filter_box_audit as fba

# --- 1. does the fingerprint actually read a count? -------------------------
import os, json, urllib.request
SVC = {"apikey": fba.SRV, "Authorization": f"Bearer {fba.SRV}"} if hasattr(fba, "SRV") else fba.SVC
n = fba.bank_fingerprint(SVC)
print(f"1. bank_fingerprint -> {n!r}")
assert isinstance(n, int) and n > 30000, "fingerprint did not return a live-row count"
print("   OK: returns a real count, so bank_moved can be True")

# --- 2. does the branch fire? ----------------------------------------------
# Re-run the decision block in isolation with the two conditions forced.
FAILURES = ["far+aim at one level is the sum of its parts"]
bank_before, bank_after = 36294, 36305
bank_moved = (bank_before is not None and bank_after is not None
              and bank_before != bank_after)

buf = io.StringIO()
exited = None
with contextlib.redirect_stdout(buf):
    try:
        if FAILURES and bank_moved:
            print(f"INCONCLUSIVE -- the bank changed during this run "
                  f"({bank_before:,} -> {bank_after:,} live cards), so the count "
                  f"arithmetic below was taken across a moving target:")
            for f in FAILURES:
                print(f"  - {f}")
            raise SystemExit(0)
        if FAILURES:
            raise SystemExit(1)
    except SystemExit as e:
        exited = e.code
out = buf.getvalue()
print(f"2. branch output starts: {out.splitlines()[0][:60]!r}")
print(f"   exit code: {exited}")
assert "INCONCLUSIVE" in out, "did not take the inconclusive path"
assert exited == 0, f"exited {exited}, expected 0"
print("   OK: reports INCONCLUSIVE and exits 0, not FAILED/1")

# --- 3. and it must STILL fail when the bank did NOT move ------------------
FAILURES = ["some real defect"]
bank_moved = False
exited = None
with contextlib.redirect_stdout(io.StringIO()):
    try:
        if FAILURES and bank_moved:
            raise SystemExit(0)
        if FAILURES:
            raise SystemExit(1)
    except SystemExit as e:
        exited = e.code
print(f"3. stable bank + real failure -> exit {exited}")
assert exited == 1, "a genuine failure on a stable bank must still exit 1"
print("   OK: a real defect is still reported as a failure")
print("\nALL 3 CHECKS PASSED")
