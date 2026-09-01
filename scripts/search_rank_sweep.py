"""Sweep candidate ranking weights for search_far over the 317-case corpus.

Control (w_sub=0) is production as it ships today. Everything else is a
candidate. Nothing here writes to the DB.
"""
import sys, json, time
sys.path.insert(0, "scripts")
from search_rank_eval import evaluate

CONFIGS = [
    ("control (production today)",      {"w_sub": 0}),
    ("subpart 60",                      {"w_sub": 60}),
    ("subpart 120",                     {"w_sub": 120}),
    ("subpart 180",                     {"w_sub": 180}),
    ("subpart 120 + and 120",           {"w_sub": 120, "w_and": 120}),
    ("subpart 120 + ts 60",             {"w_sub": 120, "w_ts": 60}),
    ("subpart 120 + and 120 + ts 60",   {"w_sub": 120, "w_and": 120, "w_ts": 60}),
]

if __name__ == "__main__":
    out = []
    for name, w in CONFIGS:
        t = time.time()
        hits, n, mrr, ranks = evaluate(w, chunk_size=20)
        out.append({"name": name, "weights": w, "hits": hits, "n": n,
                    "recall": hits/n, "mrr": mrr,
                    "ranks": {str(k): v for k, v in ranks.items()}})
        print(f"{name:<34} recall@10 {hits:>3}/{n} = {hits/n*100:5.1f}%   MRR {mrr:.3f}   ({time.time()-t:.0f}s)", flush=True)
        json.dump(out, open("/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/0ab87012-7429-47e2-9684-e807b919fea7/scratchpad/sweep.json", "w"), indent=1)
