#!/usr/bin/env python3
"""Free, deterministic mnemonic letter-recall facts for study_facts --
zero LLM cost, since every fact is a straight template pull from
dictionary_terms.senses[0].breakdown, data that's already curated/correct.

This is the literal "what does the C in COMBATS stand for" shape RC asked
for. It does NOT need the LLM authoring pass scoped alongside it -- that
pass instead covers handbook definitions + mnemonic SCENARIO-recall
("which mnemonic covers a missed approach?"), genuinely different content
this script doesn't touch.

Edge case handled: 17 of 45 letter-bearing mnemonics repeat a letter
within themselves (ARROW, DECIDE, ALARM, etc.) -- "What does the R in
ARROW stand for?" is ambiguous (two R's, two different concepts). For a
repeated letter, questions get ordinal phrasing ("the 1st R", "the 2nd
R"); a letter that appears once uses RC's plain phrasing.

Distractors: 3 wrong concepts, preferring the SAME mnemonic's other
letters first (genuinely plausible -- confusing which letter maps to
which concept in the acronym you're actually studying), falling back to
other mnemonics in the same mnemonic_group when a mnemonic has <4 letters
total. No LLM judgment needed either way -- every candidate is already a
correct concept for SOME letter, just the wrong one for this question.

3 mnemonics ("Low to High, Clear the Sky", "Hot to Cold...", "High to
Low...") are rhymes with no letter breakdown -- correctly skipped, they
have nothing to break down.

Idempotent: upserts on (item_type, item_id, question), safe to re-run.

Usage: python3 scripts/build_mnemonic_letter_facts.py
"""
import json
import os
import random
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


MGMT = load_env(".env.supabase-mgmt")
SCRAPER = load_env(".env.scraper")
SUPABASE_URL, SERVICE_KEY = SCRAPER["SUPABASE_URL"], SCRAPER["SUPABASE_SERVICE_KEY"]


def mgmt_sql(query):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{MGMT['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {MGMT['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"mgmt SQL failed: {e.code} {e.read().decode()[:2000]}")


def rest(method, path, *, body=None, prefer=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SUPABASE_URL + path, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    if data:
        req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t


ORDINALS = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", 6: "6th",
            7: "7th", 8: "8th", 9: "9th", 10: "10th", 11: "11th", 12: "12th", 13: "13th"}


def main():
    rows = mgmt_sql("""
        select slug, term, mnemonic_group, senses->0->'breakdown' as breakdown
        from dictionary_terms
        where category = 'mnemonic' and slug in (select slug from quizzable_dictionary_terms)
          and jsonb_array_length(senses->0->'breakdown') > 0
        order by slug
    """)
    print(f"Fetched {len(rows)} quizzable mnemonics with a letter breakdown.")

    # Build a group-level distractor pool (concept text) per mnemonic_group,
    # for the <4-letter fallback case.
    group_pool = {}
    for r in rows:
        grp = r["mnemonic_group"] or "_none"
        group_pool.setdefault(grp, [])
        for entry in r["breakdown"]:
            concept = (entry.get("concept") or "").strip()
            if concept:
                group_pool[grp].append((r["slug"], concept))

    facts = []
    skipped_no_concept = 0
    for r in rows:
        slug, term, grp = r["slug"], r["term"], r["mnemonic_group"] or "_none"
        breakdown = r["breakdown"]

        # Count occurrences of each letter within this mnemonic, so a
        # repeated letter gets ordinal phrasing.
        letter_counts = {}
        for entry in breakdown:
            letter_counts[entry.get("letter", "")] = letter_counts.get(entry.get("letter", ""), 0) + 1
        seen_so_far = {}

        for idx, entry in enumerate(breakdown):
            letter = (entry.get("letter") or "").strip()
            concept = (entry.get("concept") or "").strip()
            detail = (entry.get("detail") or "").strip()
            if not letter or not concept:
                skipped_no_concept += 1
                continue

            seen_so_far[letter] = seen_so_far.get(letter, 0) + 1
            if letter_counts[letter] > 1:
                question = f"What does the {ORDINALS.get(seen_so_far[letter], str(seen_so_far[letter]) + 'th')} ‘{letter}’ in {term} stand for?"
            else:
                question = f"What does the ‘{letter}’ in {term} stand for?"

            # source_quote must be an exact quote of provided text -- these
            # are template facts, not LLM-authored, so "provided text" is
            # the breakdown entry itself. Prefer detail (richer, still a
            # literal DB field) when present, else concept.
            source_quote = detail if detail else concept

            # Distractors: other letters in THIS mnemonic first (excluding
            # this exact entry by index, not by letter, so a sibling
            # occurrence of the SAME letter is still a valid, plausible
            # wrong answer).
            siblings = [
                (e.get("concept") or "").strip()
                for i, e in enumerate(breakdown)
                if i != idx and (e.get("concept") or "").strip()
            ]
            random.shuffle(siblings)
            distractors = list(dict.fromkeys(siblings))[:3]  # dedupe, keep order

            if len(distractors) < 3:
                # Fall back to other mnemonics in the same thematic group.
                fallback_candidates = [c for (s, c) in group_pool.get(grp, [])
                                        if s != slug and c not in distractors and c != concept]
                random.shuffle(fallback_candidates)
                for c in fallback_candidates:
                    if len(distractors) >= 3:
                        break
                    distractors.append(c)

            if len(distractors) < 3:
                # Extremely small group -- widen to the whole mnemonic pool.
                fallback_candidates = [c for grp2 in group_pool.values() for (s, c) in grp2
                                        if s != slug and c not in distractors and c != concept]
                random.shuffle(fallback_candidates)
                for c in fallback_candidates:
                    if len(distractors) >= 3:
                        break
                    distractors.append(c)

            if len(distractors) < 3:
                print(f"  WARNING: {slug} letter '{letter}' only found {len(distractors)} distractors, skipping")
                continue

            facts.append({
                "item_type": "dictionary", "item_id": slug,
                "question": question, "answer": concept,
                "source_quote": source_quote[:500],
                "distractors": distractors[:3],
                "status": "live", "model": "deterministic-template",
            })

    print(f"Built {len(facts)} letter-recall facts ({skipped_no_concept} breakdown entries skipped for missing letter/concept).")

    inserted = 0
    for i in range(0, len(facts), 500):
        chunk = facts[i:i + 500]
        status, body = rest("POST", "/rest/v1/study_facts?on_conflict=item_type,item_id,question",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status >= 300:
            print(f"  insert chunk {i}: HTTP {status}: {str(body)[:400]}")
        else:
            inserted += len(chunk)
    print(f"Inserted/upserted {inserted} rows into study_facts (status=live, model=deterministic-template).")


if __name__ == "__main__":
    main()
