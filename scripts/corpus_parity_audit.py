#!/usr/bin/env python3
"""Do all seven corpora offer the same features, or does one quietly lack one?

WHY
RC, 2026-09-06: "unlike the other regs, ACs don't seem to display their Recents
inside the regs own area. I believe every other one does this." He was right --
ac/library.tsx was the only corpus browse screen without a RECENTLY VIEWED row,
and nothing would ever have flagged it, because a missing feature throws no
error and appears in no log. It is only visible by COMPARISON.

This is RC's standing feature-parity rule made mechanical: line the corpora up
side by side and show which cells are empty.

An empty cell is a QUESTION, not automatically a bug -- some corpora genuinely
have no figures, and P/CG terms have no PDF to print. The point is that every
gap becomes a deliberate answer instead of an oversight nobody looked for.
"""
import os, re, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 49 CFR has NO index screen of its own, by design: NTSB/TSA/HMR are families
# inside far/index.tsx's own switcher. A first version of this audit listed
# src/app/cfr49/index.tsx here, found nothing, and reported 49CFR as missing
# every single feature -- five invented findings from one wrong path.
INDEX = {
    "AC":    "src/app/ac/library.tsx",
    "AD":    "src/app/ad/index.tsx",
    "FAR":   "src/app/far/index.tsx",
    "AIM":   "src/app/aim/index.tsx",
    "P/CG":  "src/app/pcg/index.tsx",
    "LOI":   "src/app/loi/index.tsx",
    "Dict":  "src/app/dictionary/index.tsx",
}
# AC's detail SCREEN is ac/[id].tsx; ACBody.tsx is only the body renderer it
# mounts. Pointing at the component made AC look like it lacked bookmarking,
# download, print and error handling -- all four are in the screen. Four more
# invented findings from one wrong path.
DETAIL = {
    "AC":    "src/app/ac/[id].tsx",
    "AD":    "src/app/ad/[id].tsx",
    "FAR":   "src/app/far/[id].tsx",
    "AIM":   "src/app/aim/[id].tsx",
    "P/CG":  "src/app/pcg/[id].tsx",
    "LOI":   "src/app/loi/[slug].tsx",
    "49CFR": "src/app/cfr49/[id].tsx",
    "Dict":  "src/app/dictionary/[slug].tsx",
}

INDEX_FEATURES = [
    ("Recently viewed", r"RECENTLY VIEWED"),
    ("Search box",      r"placeholder=|TextInput"),
    ("Back to top",     r"BackToTop"),
    ("Long-press peek", r"useLongPressPreview"),
    ("Load error state",r"loadError|LoadFailed"),
]
DETAIL_FEATURES = [
    ("Bookmark",        r"toggleBookmark|isBookmarked|BookmarkButton"),
    ("Download/offline",r"handleDownload|downloadAll|record_offline"),
    ("Print",           r"printReg|handlePrint|Print\."),
    ("Highlight",       r"Highlight|highlightedBlockTexts"),
    # AC implements in-doc search with its own matchIdx/matchCount pair rather
    # than the shared useInDocSearch hook -- matching only the hook name
    # reported AC as lacking a feature it has. Detect the CAPABILITY, not one
    # implementation of it.
    ("In-doc search",   r"inDocSearch|useInDocSearch|matchCount|matchIdx"),
    ("MagicLink",       r"MagicLinkPod"),
    ("Prev/next nav",   r"prevNext|PrevNext|adjacent"),
    ("Load error state",r"loadError|LoadFailed"),
    # Same shape: FAR/AIM/AD resolve the "this changed" banner through
    # getLatestRevision(), AC through its own changed_block_indices column.
    ("Updated banner",  r"getLatestRevision|changed_block_indices|changedIndices"),
]

def scan(files, features, title):
    print(f"\n=== {title} ===")
    present = {}
    for corpus, rel in files.items():
        p = os.path.join(BASE, rel)
        present[corpus] = open(p, encoding="utf-8").read() if os.path.exists(p) else None
    names = list(files.keys())
    print(f"  {'FEATURE':<20}" + "".join(f"{n:>7}" for n in names))
    gaps = []
    for label, pat in features:
        row = f"  {label:<20}"
        rx = re.compile(pat)
        hits = {}
        for n in names:
            src = present[n]
            hit = bool(src and rx.search(src))
            hits[n] = hit
            row += f"{('yes' if hit else '—'):>7}"
        print(row)
        have = [n for n in names if hits[n]]
        miss = [n for n in names if not hits[n]]
        # a gap is interesting only when MOST corpora have it
        if len(have) >= len(names) - 2 and miss:
            gaps.append((label, miss, len(have), len(names)))
    return gaps

# NOT {**INDEX, **DETAIL} -- the two dicts share keys, so merging silently
# dropped half the entries and this check passed while a path was wrong.
missing_files = [f"{kind} {c} -> {r}"
                 for kind, d in (("index", INDEX), ("detail", DETAIL))
                 for c, r in d.items()
                 if not os.path.exists(os.path.join(BASE, r))]
if missing_files:
    print("REFUSING TO REPORT: these screen paths do not exist, so every")
    print("'gap' below would be an artefact of a wrong path:")
    for m in missing_files: print("   ", m)
    sys.exit(2)
gaps = scan(INDEX, INDEX_FEATURES, "CORPUS BROWSE / INDEX SCREENS")
gaps += scan(DETAIL, DETAIL_FEATURES, "CORPUS DETAIL SCREENS")

# Gaps that have been LOOKED AT and accepted, so the audit fails only on a
# NEW one. Each needs a reason, not just an entry -- an allowlist without
# reasons is just a way to stop reading the output.
ACCEPTED = {
    # Dictionary is a glossary of short definitions, not a document corpus:
    # there is no PDF to print or download, no body long enough to need
    # in-doc search or highlights, and no citation graph for MagicLink.
    ("Recently viewed", "Dict"), ("Long-press peek", "Dict"),
    ("Download/offline", "Dict"), ("Print", "Dict"), ("Highlight", "Dict"),
    ("MagicLink", "Dict"), ("In-doc search", "Dict"), ("Updated banner", "Dict"),
    # (AC's search box and prev/next footer were BUILT on 2026-09-07 at RC's
    # request -- their allowlist entries were removed the same day rather than
    # left behind, so this audit will fail again if either is ever dropped.)
}
new_gaps = [(l, [m for m in miss if (l, m) not in ACCEPTED], h, t) for l, miss, h, t in gaps]
new_gaps = [(l, miss, h, t) for l, miss, h, t in new_gaps if miss]

print("\n" + "=" * 62)
if missing_files:
    print("screens not found (so not comparable):")
    for m in missing_files: print("   ", m)
accepted_n = sum(len(m) for _l, m, _h, _t in gaps) - sum(len(m) for _l, m, _h, _t in new_gaps)
if new_gaps:
    print(f"\n{len(new_gaps)} NEW ODD-ONE-OUT GAP(S) — most corpora have it, these do not:")
    for label, miss, have, tot in new_gaps:
        print(f"  - {label}: {have}/{tot} have it; MISSING from {', '.join(miss)}")
else:
    print("No NEW odd-one-out gaps.")
print(f"({accepted_n} known gap(s) accepted with a documented reason — see ACCEPTED.)")
sys.exit(1 if new_gaps else 0)
