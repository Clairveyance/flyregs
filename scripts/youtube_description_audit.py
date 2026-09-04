#!/usr/bin/env python3
"""Does each video's description only claim what the video actually says?

RC, 2026-09-04: "you need to double check and edit the Description boxes in
the YT vids. You're listing things that aren't in the vid. (in the MM vid, i
don't discuss SS, ML, etc, but you put it in as Covered.) fix all that, in
every vid. make sure you always analyze the actual vid content to make sure
you're info is accurate."

He was right. The Main Menu description listed "how SmartSearch, MagicLink and
Ask FlyRegs differ" under WHAT'S COVERED. Those three phrases appear ZERO
times in that video's narration -- the FAQ page is shown, and one FAQ about
badge colours is opened, and that is all. Two of its tags were the same two
features.

This makes the check mechanical instead of a promise to be careful. For every
video it holds a transcript for, it takes the feature names the description
claims and asks whether the narration ever mentions them.

WHAT IT CAN AND CANNOT TELL YOU
-------------------------------
It reads WORDS. A description can be wrong in ways no word-match will catch --
a claim about tiers, a number that has since changed, a chapter timestamp
pointing at the wrong place. Those still need a person. What this catches is
the specific failure that actually happened: naming a feature the video never
discusses.

Timestamps are checked too, but only for the one thing that is checkable
without judgement: a chapter that runs past the end of the video, or chapters
that are out of order.

Transcripts live in 04_Marketing/YouTube/00 Channel/transcripts/ as
caption_<videoId>.srt. Download one with:

    python3 scripts/youtube_api.py captions <videoId>            # lists tracks
    python3 scripts/youtube_api.py captions <videoId> --download <trackId>

Usage: python3 scripts/youtube_description_audit.py
"""
import os
import re
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPTS = os.path.normpath(os.path.join(
    BASE, "..", "04_Marketing", "YouTube", "00 Channel", "transcripts"))

# Feature and product names worth policing. A description naming one of these
# is asserting the video covers it, which is exactly the claim RC caught being
# false. The alternates exist because these are AUTO-generated captions: the
# ASR mangles the product's own names fairly consistently, and matching only
# the correct spelling would flag every video as omitting everything.
FEATURES = {
    "SmartSearch":  ["smartsearch", "smart search"],
    "MagicLink":    ["magiclink", "magic link"],
    "Ask FlyRegs":  ["ask flyregs", "ask fly regs", "ask flygs", "ask fly rigs",
                     "ask fly eggs", "ask flyrigs"],
    "What's New":   ["what's new", "whats new"],
    "DailyReg":     ["daily reg", "dailyreg", "daily rag", "daily reggg"],
    "DailyWord":    ["daily word", "dailyword"],
    "Red Shift":    ["red shift", "redshift"],
    "My Fleet":     ["my fleet", "fleet"],
    "The Wing":     ["the wing"],
    "Duel":         ["duel"],
    "Study Mode":   ["study mode"],
    "Reminders":    ["reminder"],
    "Equipment":    ["equipment"],
    "MagicLink linkages": ["linkage"],
    "dictionary":   ["dictionary"],
    "mnemonics":    ["mnemonic", "pneumonic"],
    "callsign":     ["call sign", "callsign"],
    "avatar":       ["avatar"],
    "Send Feedback": ["feedback"],
    "FAQ":          ["faq", "frequently asked"],
    "Browse by Regulation": ["browse by regulation"],
    "Changed tab":  ["changed"],
    "tach":         ["tach", "hobs", "hobbs"],
}

VIDEOS = [
    ("w4bq0GoAVyw", "01 Main Menu"),
    ("Cz7lFECAWLU", "02 Home Screen"),
    ("M3zlKYdPbwM", "03 Search"),
]

problems = []


def transcript_for(vid):
    path = os.path.join(TRANSCRIPTS, f"caption_{vid}.srt")
    if not os.path.exists(path):
        return None, None
    raw = open(path, encoding="utf-8").read()
    words, last_ts = [], 0
    for block in raw.split("\n\n"):
        lines = [l for l in block.strip().split("\n") if l.strip()]
        if len(lines) >= 3 and "-->" in lines[1]:
            h, m, s = lines[1].split(" --> ")[1][:8].split(":")
            last_ts = max(last_ts, int(h) * 3600 + int(m) * 60 + int(float(s)))
            words.append(" ".join(lines[2:]))
    return " ".join(words).lower(), last_ts


def live_description(vid):
    out = subprocess.run(
        [sys.executable, os.path.join(BASE, "scripts", "youtube_api.py"), "get", vid],
        capture_output=True, text=True, timeout=180).stdout
    # The response is JSON but carries raw newlines inside the description, so
    # json.loads chokes on it -- pull the field out directly instead.
    m = re.search(r'"description":\s*"((?:[^"\\]|\\.)*)"', out, re.S)
    if not m:
        return None
    return m.group(1).encode().decode("unicode_escape")


def check(vid, label):
    print(f"\n=== {label}  ({vid}) ===")
    narration, duration = transcript_for(vid)
    if narration is None:
        print(f"  SKIP  no transcript at {TRANSCRIPTS}/caption_{vid}.srt")
        return
    desc = live_description(vid)
    if desc is None:
        print("  SKIP  could not read the live description")
        return
    low = desc.lower()

    claimed_but_absent = []
    for name, alts in FEATURES.items():
        if name.lower() not in low:
            continue
        if not any(a in narration for a in alts):
            claimed_but_absent.append(name)
    if claimed_but_absent:
        for n in claimed_but_absent:
            print(f"  FAIL  description names \"{n}\" -- the narration never mentions it")
            problems.append(f"{label}: claims {n}")
    else:
        print(f"  PASS  every feature the description names is actually discussed")

    # The channel's own rule, in 00 Channel/README.md: "Descriptions never
    # contain support@flyregs.com (spam magnet, and it is the same inbox real
    # bug reports land in). Point at flyregs.com instead."
    #
    # Checked here because I broke it -- I added a "Questions:
    # support@flyregs.com" line to all three descriptions on 2026-09-04 while
    # rewriting them, and RC caught it. A rule written in a README is a rule
    # nobody runs.
    if "support@flyregs.com" in low:
        print("  FAIL  description contains support@flyregs.com -- the channel "
              "README forbids it (spam magnet, and it is the support inbox)")
        problems.append(f"{label}: support email in the description")
    else:
        print("  PASS  no support email in the description")

    # Chapters: only the two things checkable without judgement.
    stamps = re.findall(r"^(\d+):(\d\d)\s+(.+)$", desc, re.M)
    if stamps:
        secs = [int(a) * 60 + int(b) for a, b, _ in stamps]
        if secs != sorted(secs):
            print("  FAIL  chapter timestamps are out of order")
            problems.append(f"{label}: chapters out of order")
        over = [f"{a}:{b} {t}" for (a, b, t), s in zip(stamps, secs) if s > duration]
        if over:
            print(f"  FAIL  chapter(s) past the end of the {duration // 60}:{duration % 60:02d} video: {over}")
            problems.append(f"{label}: chapter past the end")
        if secs == sorted(secs) and not over:
            print(f"  PASS  {len(stamps)} chapters, in order, all within {duration // 60}:{duration % 60:02d}")

    # Not a pass/fail -- the reverse direction is a content suggestion, not a
    # defect. A video can legitimately show something in passing without the
    # description listing it.
    missing = [n for n, alts in FEATURES.items()
               if n.lower() not in low and any(a in narration for a in alts)]
    if missing:
        print(f"  note  discussed but not in the description: {', '.join(missing)}")


def main():
    print("Do the descriptions match what the videos actually say?")
    for vid, label in VIDEOS:
        check(vid, label)
    print()
    if problems:
        print(f"{len(problems)} PROBLEM(S):")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("Every description claims only what its video actually covers.")


if __name__ == "__main__":
    main()
