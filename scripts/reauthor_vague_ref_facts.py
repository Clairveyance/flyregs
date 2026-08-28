#!/usr/bin/env python3
"""One-off: re-author the 531 fact cards flagged 2026-08-28 for the "this AC"/
"this section" vague-self-reference bug (see author_fact_deck.py's
VAGUE_SELF_REF_RE comment for the full incident). Targets exactly this list,
not the whole flagged pool (~4,000 other items were flagged earlier for
unrelated verify-pass reasons and aren't touched here).

Usage:
  python3 scripts/reauthor_vague_ref_facts.py --submit
  python3 scripts/reauthor_vague_ref_facts.py --poll
  python3 scripts/reauthor_vague_ref_facts.py --verify
  python3 scripts/reauthor_vague_ref_facts.py --verify-poll
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import author_fact_deck as afd

TARGET_LIST = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/dda71396-47d8-4940-b2fe-bbaf460c155b/scratchpad/vague_ref_items.json"
STATE_PATH = os.path.join(afd.BASE, "scripts", ".reauthor_vague_batch_state.json")
ID_MAP_PATH = os.path.join(afd.BASE, "scripts", ".reauthor_vague_id_map.json")


def fetch_targets():
    targets = json.load(open(TARGET_LIST))
    by_type = {}
    for t in targets:
        by_type.setdefault(t["item_type"], []).append(t["item_id"])

    out = []
    if "far" in by_type:
        ids = "','".join(by_type["far"])
        rows = afd.mgmt_sql(f"select section_number as item_id, title, body_text from far_sections where section_number in ('{ids}')")
        out += [("far", r) for r in rows]
    if "ac" in by_type:
        ids = "','".join(by_type["ac"])
        rows = afd.mgmt_sql(f"select document_number as item_id, title, description as body_text from advisory_circulars where document_number in ('{ids}')")
        out += [("ac", r) for r in rows]
    if "aim" in by_type:
        ids = "','".join(by_type["aim"])
        rows = afd.mgmt_sql(f"select paragraph_number as item_id, title, body_text from aim_paragraphs where paragraph_number in ('{ids}')")
        out += [("aim", r) for r in rows]
    return out


def cmd_submit():
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
        if state.get("status") != "ended":
            print(f"Refusing to resubmit -- batch {state['batch_id']} already exists (status: {state.get('status')}). Use --poll.")
            sys.exit(1)

    import anthropic
    env = afd.load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    sources = fetch_targets()
    print(f"Re-authoring {len(sources)} items flagged for the vague-self-reference bug.")

    id_map = {}
    requests_ = []
    for seq, (t, r) in enumerate(sources):
        cid = f"vague_{seq}"
        id_map[cid] = {"item_type": t, "item_id": r["item_id"]}
        requests_.append(afd.build_request(t, r, cid))
    json.dump(id_map, open(ID_MAP_PATH, "w"))

    batch = client.messages.batches.create(requests=requests_)
    state = {"batch_id": batch.id, "status": batch.processing_status, "item_count": len(sources)}
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")


def cmd_poll():
    if not os.path.exists(STATE_PATH):
        print("No batch state -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))

    import anthropic
    env = afd.load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])
    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Batch {batch.id}: {batch.processing_status} "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored} processing={batch.request_counts.processing})")
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet.")
        return

    id_map = json.load(open(ID_MAP_PATH))
    sources = {(t, r["item_id"]): r for t, r in fetch_targets()}

    accepted = rejected_shape = rejected_ungrounded = rejected_vague = empty = errored = 0
    rows = []
    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            errored += 1
            continue
        msg = result.result.message
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            rejected_shape += 1
            continue
        facts = parsed.get("facts", [])
        if not facts:
            empty += 1
            continue
        mapped = id_map.get(result.custom_id)
        if not mapped:
            rejected_shape += 1
            continue
        item_type, item_id = mapped["item_type"], mapped["item_id"]
        src = sources.get((item_type, item_id))
        src_body_norm = afd.normalize_ws(src["body_text"]) if src else ""
        for fact in facts[:3]:
            q, a, quote = fact.get("question", ""), fact.get("answer", ""), fact.get("source_quote", "")
            if not (q.strip().endswith("?") and 8 <= len(q) <= 160 and 1 <= len(a) <= 110):
                rejected_shape += 1
                continue
            if afd.VAGUE_SELF_REF_RE.search(q):
                rejected_vague += 1
                continue
            if afd.normalize_ws(quote) not in src_body_norm:
                rejected_ungrounded += 1
                continue
            accepted += 1
            rows.append({
                "item_type": item_type, "item_id": item_id,
                "question": q.strip(), "answer": a.strip(), "source_quote": quote.strip(),
                "status": "pending", "model": afd.AUTHOR_MODEL,
            })

    print(f"Parsed {batch.request_counts.succeeded}: {accepted} accepted, {empty} empty, "
          f"{rejected_shape} shape-rejected, {rejected_vague} STILL vague (guard caught it), "
          f"{rejected_ungrounded} ungrounded, {errored} errors.")

    if not rows:
        print("Nothing to insert.")
        return
    inserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        status, body = afd.rest("POST", "/rest/v1/study_facts?on_conflict=item_type,item_id,question",
                                 body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status >= 300:
            print(f"  insert chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            inserted += len(chunk)
    print(f"Inserted {inserted} rows as status=pending. Run --verify next.")


def cmd_verify():
    afd.cmd_verify()


def cmd_verify_poll():
    afd.cmd_verify_poll()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--verify-poll", action="store_true")
    args = ap.parse_args()
    if args.submit:
        cmd_submit()
    elif args.poll:
        cmd_poll()
    elif args.verify:
        cmd_verify()
    elif args.verify_poll:
        cmd_verify_poll()
    else:
        print(__doc__)
