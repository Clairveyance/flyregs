"""Holdout check: score the winning weights against the ORIGINAL 94-case set.

That set was written before the subpart/phrase signals existed and before RC's
"private pilot knowledge test" report was diagnosed, so it is independent of
the feature design and of the 317 cases written afterwards. If the winner only
wins on the set it was tuned against, it is overfit and does not ship.

The three NTSB Part 830 cases are dropped: 830 is 49 CFR and was never in
far_sections, so they are a harness artifact, not a search miss.
"""
import sys
sys.path.insert(0, "scripts")
from search_relevance_eval import CURATED
from search_rank_eval import evaluate

HOLDOUT = [(q, e) for q, e in CURATED
           if not any(s.startswith("830.") for s in e)]

if __name__ == "__main__":
    import json
    weights = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(f"holdout cases: {len(HOLDOUT)} (of {len(CURATED)}; dropped NTSB 830)")
    ch, cn, cmrr, _ = evaluate({}, cases=HOLDOUT, chunk_size=20)
    print(f"  CONTROL   recall@10 {ch:>2}/{cn} = {ch/cn*100:5.1f}%   MRR {cmrr:.3f}")
    wh, wn, wmrr, _ = evaluate(weights, cases=HOLDOUT, chunk_size=20)
    print(f"  CANDIDATE recall@10 {wh:>2}/{wn} = {wh/wn*100:5.1f}%   MRR {wmrr:.3f}   weights={weights}")
    print(f"  delta: recall {(wh-ch)/cn*100:+.1f}pp   MRR {wmrr-cmrr:+.3f}")
