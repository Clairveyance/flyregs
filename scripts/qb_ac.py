#!/usr/bin/env python3
"""Pull keyword-anchored excerpts from an AC's pdf_text, for authoring.

An AC is 20k-3M characters; dumping it is useless and dumping the first page is
worse (it is a cover sheet and a table of contents). This pulls windows around
the terms that actually carry testable content.
"""
import os, re, sys
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
from access_matrix_sweep import mgmt

doc, kws = sys.argv[1], sys.argv[2:]
r = mgmt("select document_number, title, pdf_text from advisory_circulars where document_number = '%s'" % doc)
if not r:
    print("no such AC:", doc); sys.exit(1)
t = re.sub(r"\s+", " ", r[0]["pdf_text"] or "")
print("===== %s — %s  (%d chars) =====" % (r[0]["document_number"], r[0]["title"], len(t)))
seen = []
for kw in kws:
    for m in re.finditer(re.escape(kw), t, re.I):
        if any(abs(m.start() - s) < 300 for s in seen):
            continue
        seen.append(m.start())
        print("\n--- %s" % kw)
        print("   " + t[max(0, m.start() - 320): m.start() + 420])
        break
