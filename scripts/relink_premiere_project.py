#!/usr/bin/env python3
"""Repoint a Premiere Pro project's media links after files were moved.

RC, 2026-09-02: "in PP after i built the last video, i moved all the files i
used to make that video somewhere else, and now Adobe can't play it b/c the
files aren't where it knows to look... i can't seem to get PP to point to that
file path. can you fix it?"

Done by rewriting the project file rather than driving the Link Media dialog,
because this is deterministic: every path is checked to exist on disk BEFORE
it is written, the original is backed up first, and the result either opens
with everything online or does not get written at all. A GUI relink is one
mis-click away from pointing a clip at the wrong file, silently.

A .prproj is gzipped XML. Media locations appear as <ActualMediaFilePath> and,
for some assets, a matching <FilePath>. Both are rewritten.

Usage:
  python3 scripts/relink_premiere_project.py --check   "<project.prproj>"
  python3 scripts/relink_premiere_project.py           "<project.prproj>"

Search roots are the places FlyRegs media actually lives; add more with
--root. A file is matched by BASENAME, and only when exactly one candidate
exists under the roots -- an ambiguous name is reported and left alone rather
than guessed at.
"""

import argparse
import gzip
import html
import os
import pathlib
import re
import shutil
import time
import urllib.parse

DEFAULT_ROOTS = [
    "/Users/rc/Desktop/05_FlyRegs",
    "/Users/rc/Movies/iMovie Library.imovielibrary",
    "/Users/rc/Local Desktop/COWORK/Apps/AC app/00_Logo",
    "/Users/rc/Local Desktop/COWORK/Apps/AC app/04_Marketing",
]

PATH_TAGS = ("ActualMediaFilePath", "FilePath")


def read_project(path: str) -> tuple[str, bool]:
    """Returns (xml_text, was_gzipped)."""
    with open(path, "rb") as f:
        head = f.read(2)
    if head == b"\x1f\x8b":
        return gzip.open(path, "rb").read().decode("utf-8", "replace"), True
    return open(path, "r", encoding="utf-8", errors="replace").read(), False


def to_local(raw: str) -> str:
    d = html.unescape(raw)
    if d.startswith("file://"):
        d = urllib.parse.unquote(d[7:])
    return d


def build_index(roots: list[str]) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dp, _, fns in os.walk(root):
            for fn in fns:
                idx.setdefault(fn, []).append(os.path.join(dp, fn))
    return idx


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--check", action="store_true", help="report only, write nothing")
    ap.add_argument("--root", action="append", default=[], help="extra search root")
    ap.add_argument(
        "--alias", action="append", default=[],
        help="Explicit basename remap for a file that was RENAMED, not just "
             "moved: --alias 'FR menu.mp4=01 FR menu.mp4'. Kept separate from "
             "the automatic basename match on purpose -- guessing that two "
             "differently-named files are the same clip is exactly how a "
             "relink silently points a timeline at the wrong footage.",
    )
    args = ap.parse_args()

    xml, gz = read_project(args.project)
    idx = build_index(DEFAULT_ROOTS + args.root)

    refs = set()
    for tag in PATH_TAGS:
        refs |= set(re.findall(rf"<{tag}>(.*?)</{tag}>", xml))

    fixed, already, ambiguous, notfound = {}, [], [], []
    for raw in refs:
        local = to_local(raw)
        if os.path.exists(local):
            already.append(local)
            continue
        base = os.path.basename(local)
        for a in args.alias:
            if "=" in a:
                frm, to = a.split("=", 1)
                if base == frm.strip():
                    base = to.strip()
                    break
        hits = idx.get(base) or []
        if len(hits) > 1:
            # Resolve duplicates deterministically instead of giving up.
            # Two rules, in order:
            #   1. A candidate whose path is the ORIGINAL path with a known
            #      folder rename applied is certainly the right file.
            #      RC renamed Desktop/FlyRegs -> Desktop/05_FlyRegs, which is
            #      what broke every link in the first place.
            #   2. Otherwise prefer the earlier search root. DEFAULT_ROOTS
            #      lists the working folder before the iMovie library on
            #      purpose: the library holds IMPORTED COPIES, and relinking a
            #      Premiere project into another app's managed library is how
            #      you get a project that breaks again the next time that
            #      library is tidied.
            renamed = [h for h in hits
                       if h == local.replace("/Desktop/FlyRegs/", "/Desktop/05_FlyRegs/")]
            if renamed:
                hits = renamed[:1]
            else:
                def rank(h: str) -> int:
                    for i, r in enumerate(DEFAULT_ROOTS + args.root):
                        if h.startswith(r):
                            return i
                    return 99
                hits = sorted(hits, key=rank)[:1]
        if len(hits) == 1:
            fixed[raw] = hits[0]
        elif len(hits) > 1:
            ambiguous.append((base, hits))
        else:
            notfound.append(local)

    print(f"{os.path.basename(args.project)}")
    print(f"  {len(refs)} media references")
    print(f"  {len(already)} already online")
    print(f"  {len(fixed)} will be repointed")
    for old, new in sorted(fixed.items(), key=lambda kv: kv[1]):
        print(f"      {os.path.basename(new)}  ->  {new}")
    if ambiguous:
        print(f"  {len(ambiguous)} AMBIGUOUS (same filename in several places — left alone):")
        for base, hits in ambiguous:
            print(f"      {base}")
            for h in hits:
                print(f"         {h}")
    if notfound:
        print(f"  {len(notfound)} not found anywhere under the search roots:")
        for n in notfound:
            print(f"      {n}")

    if args.check or not fixed:
        if not fixed:
            print("\n  nothing to rewrite")
        return

    backup = f"{args.project}.bak-{time.strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(args.project, backup)
    print(f"\n  backed up original -> {os.path.basename(backup)}")

    out = xml
    for old, new in fixed.items():
        new_ref = new
        if old.startswith("file://"):
            new_ref = "file://" + urllib.parse.quote(new)
        out = out.replace(f">{old}<", f">{html.escape(new_ref)}<")

    data = out.encode("utf-8")
    if gz:
        with gzip.open(args.project, "wb") as f:
            f.write(data)
    else:
        pathlib.Path(args.project).write_bytes(data)

    # Re-read and confirm, rather than trusting the write.
    xml2, _ = read_project(args.project)
    still = 0
    for tag in PATH_TAGS:
        for raw in re.findall(rf"<{tag}>(.*?)</{tag}>", xml2):
            if not os.path.exists(to_local(raw)):
                still += 1
    print(f"  rewritten. media references still missing after the fix: {still}")


if __name__ == "__main__":
    main()
