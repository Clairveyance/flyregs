"""Second sweep: add document term-coverage (w_doc) on top of the subpart fix.

Rationale: today a section is rewarded for query terms in its TITLE (180) but
gets essentially nothing for covering those terms in its BODY -- only an
exact-phrase LIKE worth 40, plus ts_rank*20. Since search_far ORs its terms, a
section matching 1 of 4 terms competes with one matching 4 of 4. w_doc scores
the fraction of query lexemes present anywhere in the stored search_vector,
which is the cheap way to say "this document is actually about all of this".
"""
import sys, json, time
sys.path.insert(0, "scripts")
from search_rank_eval import evaluate

CONFIGS = [
    ("sub180 only (sweep1 best)",        {"w_sub": 180}),
    ("sub180 + doc 120",                 {"w_sub": 180, "w_doc": 120}),
    ("sub180 + doc 240",                 {"w_sub": 180, "w_doc": 240}),
    ("sub180 + doc 360",                 {"w_sub": 180, "w_doc": 360}),
    ("sub180 + doc 240 + ts 60",         {"w_sub": 180, "w_doc": 240, "w_ts": 60}),
    ("sub240 + doc 240",                 {"w_sub": 240, "w_doc": 240}),
]
OUT = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/0ab87012-7429-47e2-9684-e807b919fea7/sweep2.json"

if __name__ == "__main__":
    out = []
    for name, w in CONFIGS:
        t = time.time()
        hits, n, mrr, ranks = evaluate(w, chunk_size=20)
        out.append({"name": name, "weights": w, "hits": hits, "n": n, "recall": hits/n, "mrr": mrr,
                    "ranks": {str(k): v for k, v in ranks.items()}})
        print(f"{name:<30} recall@10 {hits:>3}/{n} = {hits/n*100:5.1f}%   MRR {mrr:.3f}   ({time.time()-t:.0f}s)", flush=True)
        json.dump(out, open(OUT, "w"), indent=1)
