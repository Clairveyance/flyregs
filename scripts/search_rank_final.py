"""Consolidated sequential sweep. Recall is deterministic, so the 69.1%/0.526
control measured in sweep1 stands as the comparison point and is not re-run.
"""
import sys, json, time
sys.path.insert(0, "scripts")
from search_rank_eval import evaluate

CONFIGS = [
    ("sub180+doc240",                         {"w_sub":180,"w_doc":240}),
    ("+sp300",                                {"w_sub":180,"w_doc":240,"w_subphrase":300}),
    ("+sp300+tp200",                          {"w_sub":180,"w_doc":240,"w_subphrase":300,"w_titlephrase":200}),
    ("+sp450+tp200",                          {"w_sub":180,"w_doc":240,"w_subphrase":450,"w_titlephrase":200}),
    ("+sp300+tp350",                          {"w_sub":180,"w_doc":240,"w_subphrase":300,"w_titlephrase":350}),
    ("+sp300+tp200 doc120",                   {"w_sub":180,"w_doc":120,"w_subphrase":300,"w_titlephrase":200}),
    ("+sp300+tp200 and120",                   {"w_sub":180,"w_doc":240,"w_subphrase":300,"w_titlephrase":200,"w_and":120}),
]
OUT = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/0ab87012-7429-47e2-9684-e807b919fea7/final.json"

if __name__ == "__main__":
    out = []
    print("CONTROL (production, from sweep1): recall@10 219/317 = 69.1%   MRR 0.526", flush=True)
    for name, w in CONFIGS:
        t = time.time()
        hits, n, mrr, ranks = evaluate(w, chunk_size=20)
        out.append({"name": name, "weights": w, "hits": hits, "n": n, "recall": hits/n, "mrr": mrr,
                    "ranks": {str(k): v for k, v in ranks.items()}})
        print(f"{name:<26} recall@10 {hits:>3}/{n} = {hits/n*100:5.1f}%   MRR {mrr:.3f}   ({time.time()-t:.0f}s)", flush=True)
        json.dump(out, open(OUT,"w"), indent=1)
    best = max(out, key=lambda r:(r["recall"], r["mrr"]))
    print(f"\nBEST: {best['name']}  {best['recall']*100:.1f}%  MRR {best['mrr']:.3f}  weights={best['weights']}", flush=True)
