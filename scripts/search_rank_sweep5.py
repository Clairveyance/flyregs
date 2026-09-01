"""Sweep the two STRUCTURAL correlation mechanisms.

RC: "our system must be smart/intelligent enough to correlate those. And just
these small examples i bring to you, we need a smart system that does this w/o
me having to intervene."

So the four hand-added concept anchors were DELETED before this ran. If a
mechanism here earns its keep, the correlation is systemic and applies to every
query nobody has ever reported.

Baseline is the currently-shipped config (w_sub=180, w_doc=240) with no anchors.
"""
import sys, json, time
sys.path.insert(0, "scripts")
from search_rank_eval import evaluate

BASE = {"w_sub": 180, "w_doc": 240}
def cfg(**kw): d = dict(BASE); d.update(kw); return d

CONFIGS = [
    ("shipped baseline",        cfg()),
    ("general 60",              cfg(w_general=60)),
    ("general 120",             cfg(w_general=120)),
    ("general 200",             cfg(w_general=200)),
    ("cite 40",                 cfg(w_cite=40)),
    ("cite 80",                 cfg(w_cite=80)),
    ("general 120 + cite 40",   cfg(w_general=120, w_cite=40)),
    ("general 60 + cite 80",    cfg(w_general=60, w_cite=80)),
]
OUT = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/0ab87012-7429-47e2-9684-e807b919fea7/sweep5.json"

if __name__ == "__main__":
    out = []
    for name, w in CONFIGS:
        t = time.time()
        hits, n, mrr, ranks = evaluate(w, chunk_size=20)
        out.append({"name": name, "weights": w, "hits": hits, "n": n, "recall": hits/n, "mrr": mrr})
        print(f"{name:<24} recall@10 {hits:>3}/{n} = {hits/n*100:5.1f}%   MRR {mrr:.3f}   ({time.time()-t:.0f}s)", flush=True)
        json.dump(out, open(OUT,"w"), indent=1)
    best = max(out, key=lambda r:(r["recall"], r["mrr"]))
    print(f"\nBEST: {best['name']}  {best['recall']*100:.1f}%  MRR {best['mrr']:.3f}", flush=True)
