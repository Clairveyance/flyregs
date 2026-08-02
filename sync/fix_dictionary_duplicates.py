#!/usr/bin/env python3
"""One-time cleanup for the cross-source duplicate-term bug found live
2026-08-01 (RC spotted "Skin friction drag" appearing twice in search
results). Root cause: extract_dictionary_prose_glossary.py used to slug
each row as `{source_file}-{term-slug}`, so the same real term appearing
in two different FAA handbook glossaries within one batch run (e.g. IFH's
and PHAK's glossaries both define "Skin friction drag") got two separate
rows that never deduped against each other. Fixed at the source in that
script (now merges by lower(term) before insert); this script cleans up
the 444 duplicate-term groups / 503 redundant rows that already exist.

For each group of rows sharing the same lower(term): keep the oldest row
(by id, arbitrary but deterministic), merge every OTHER row's distinct
senses into it (case-insensitive de-dupe on definition text) and combine
their `source` fields, then delete the other rows.

Usage:
  python3 sync/fix_dictionary_duplicates.py --dry-run
  python3 sync/fix_dictionary_duplicates.py
"""
import argparse, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import mgmt_sql  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = mgmt_sql("select id, term, senses, source from dictionary_terms order by term, id")
    groups = defaultdict(list)
    for r in rows:
        groups[r["term"].lower()].append(r)

    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"{len(dup_groups)} duplicate-term groups, {sum(len(v) - 1 for v in dup_groups.values())} redundant rows.")

    updates, delete_ids = [], []
    for key, group in dup_groups.items():
        keep = group[0]
        merged_senses = list(keep["senses"])
        seen_defs = {s["definition"].strip().lower() for s in merged_senses}
        sources = [keep["source"]]
        for other in group[1:]:
            for s in other["senses"]:
                d = s["definition"].strip().lower()
                if d not in seen_defs:
                    seen_defs.add(d)
                    merged_senses.append(s)
            if other["source"] not in sources:
                sources.append(other["source"])
            delete_ids.append(other["id"])
        updates.append({
            "id": keep["id"], "term": keep["term"],
            "senses": merged_senses, "source": "; ".join(sources),
        })

    if args.dry_run:
        for u in updates[:10]:
            print(f"  KEEP {u['id']}: '{u['term']}' -> {len(u['senses'])} sense(s), source: {u['source'][:100]}")
        print(f"  ... {len(updates)} total merges, {len(delete_ids)} rows to delete")
        return

    import json as _json
    for u in updates:
        senses_json = _json.dumps(u["senses"]).replace("'", "''")
        source_esc = u["source"].replace("'", "''")
        mgmt_sql(f"update dictionary_terms set senses = '{senses_json}'::jsonb, source = '{source_esc}' where id = '{u['id']}'")

    if delete_ids:
        id_list = ",".join(f"'{i}'" for i in delete_ids)
        mgmt_sql(f"delete from dictionary_terms where id in ({id_list})")

    print(f"Merged {len(updates)} terms, deleted {len(delete_ids)} redundant rows.")


if __name__ == "__main__":
    main()
