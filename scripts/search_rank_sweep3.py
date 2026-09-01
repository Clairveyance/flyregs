"""Third sweep: query-bigram phrase containment in subpart / title.

Word COVERAGE cannot express mismatch, only presence: for "private pilot
knowledge test", 61.185 (Subpart H, Flight Instructors ... Sport Pilot Rating)
scores a subpart hit purely because the word "pilot" appears there, while
61.105 (Subpart E, Private Pilots) -- the section actually about private pilot
knowledge -- scored no better. Phrase containment fixes that: the query bigram
"private pilot" IS inside "Subpart E-Private Pilots" and is NOT inside
Subpart H's title.
"""
import sys, json, time
sys.path.insert(0, "scripts")
from search_rank_eval import evaluate

CONFIGS = [
    ("sub180+doc240 (sweep2 ref)",              {"w_sub":180,"w_doc":240}),
    ("+subphrase300",                            {"w_sub":180,"w_doc":240,"w_subphrase":300}),
    ("+subphrase300+titlephrase200",             {"w_sub":180,"w_doc":240,"w_subphrase":300,"w_titlephrase":200}),
    ("+subphrase450+titlephrase200",             {"w_sub":180,"w_doc":240,"w_subphrase":450,"w_titlephrase":200}),
    ("+subphrase300+titlephrase350",             {"w_sub":180,"w_doc":240,"w_subphrase":300,"w_titlephrase":350}),
    ("+subphrase200+titlephrase200 doc120",      {"w_sub":180,"w_doc":120,"w_subphrase":200,"w_titlephrase":200}),
]
OUT = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/0ab87012-7429-47e2-9684-e807b919fea7/sweep3.json"

if __name__ == "__main__":
    out = []
    for name, w in CONFIGS:
        t = time.time()
        hits, n, mrr, ranks = evaluate(w, chunk_size=20)
        out.append({"name": name, "weights": w, "hits": hits, "n": n, "recall": hits/n, "mrr": mrr,
                    "ranks": {str(k): v for k, v in ranks.items()}})
        print(f"{name:<40} recall@10 {hits:>3}/{n} = {hits/n*100:5.1f}%   MRR {mrr:.3f}   ({time.time()-t:.0f}s)", flush=True)
        json.dump(out, open(OUT, "w"), indent=1)
