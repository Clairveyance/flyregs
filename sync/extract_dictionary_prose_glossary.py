#!/usr/bin/env python3
"""Aviation Dictionary tier 3: structure raw PDF-extracted prose glossary
text ("Term. Definition sentence(s).") into clean (term, definition) pairs
via the Batches API, then load into dictionary_terms (category='handbook').

Why an LLM pass at all, when the contractions/Appendix-B tiers needed none:
those sources were ALREADY clean term->definition pairs (JO 7340.2's own
HTML table, PHAK's own PDF bookmarks). A prose glossary chapter like the
Airplane Flying Handbook's ("Absolute altitude. The vertical distance...")
is real body text with PDF-extraction artifacts -- stray spaces WITHIN
words from column-justified text ("iden tical" -> "identical") and
mid-sentence line wraps. Validated on a real 3,000-char sample (2026-08-01):
15/15 entries extracted with definitions reproduced VERBATIM (only spacing
fixed, zero paraphrasing) at ~$0.0005/entry batch-rate cost. The system
prompt explicitly forbids paraphrasing/summarizing -- this is cleanup, not
authoring, which is why it's a materially different risk than the
(separate, not-yet-approved) informal/slang tier that would need the model
to generate content from general knowledge rather than faithfully
transcribe real text already in hand.

Each source file is a plain .txt already extracted from its PDF (see
sync/.dictionary_sources/ -- one file per handbook glossary, produced by
whatever fetch step found it). This script chunks each file, submits a
single combined batch across all of them, and on --poll loads accepted
entries into dictionary_terms, using each row's own source-quote-adjacent
term as an implicit grounding check (paired against the raw source text a
second time before insert, not just trusted from the model's output).

Usage:
  python3 sync/extract_dictionary_prose_glossary.py --submit
  python3 sync/extract_dictionary_prose_glossary.py --poll
"""
import argparse, json, os, re, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, load_env  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
SOURCES_DIR = os.path.join(BASE, ".dictionary_sources")
STATE_PATH = os.path.join(BASE, ".dictionary_prose_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, ".dictionary_prose_id_map.json")
MODEL = "claude-sonnet-5"
CHUNK_CHARS = 6000  # keeps each request's output comfortably under max_tokens

SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"term": {"type": "string"}, "definition": {"type": "string"}},
                "required": ["term", "definition"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["entries"],
    "additionalProperties": False,
}

SYSTEM = """You clean up raw PDF-extracted glossary text into structured term/definition pairs.

The input is real text extracted from an official FAA handbook glossary. It has minor PDF-extraction artifacts: stray extra spaces WITHIN words (e.g. "iden tical" should be "identical", "scop e" should be "scope") caused by column-justified text extraction, and line-wrap breaks mid-sentence.

Your job:
1. Split the text into individual (term, definition) entries -- each entry starts with the defined term followed by a period, then its definition. The term itself should NOT include the trailing period.
2. Fix ONLY the stray-space artifacts within words (rejoin words that were incorrectly split by an extra space). Do NOT paraphrase, shorten, summarize, or otherwise alter the actual definition content -- reproduce it faithfully, just with the spacing artifacts fixed and line-wraps joined into flowing text.
3. Skip section header lines that are just a single letter (like "A" or "B") or category headers (like "Numbers and Symbols") -- those aren't entries.
4. If a chunk starts or ends mid-entry (cut off), only emit COMPLETE entries -- drop a truncated leading or trailing fragment rather than guessing at missing text.

Respond with JSON only, matching the schema."""


def chunk_text(text, size=CHUNK_CHARS):
    # Break on blank-ish boundaries where possible so chunks don't split
    # mid-entry as often; the system prompt's instruction #4 covers the rest.
    chunks, i = [], 0
    while i < len(text):
        end = min(i + size, len(text))
        if end < len(text):
            nl = text.rfind("\n", i + size - 500, end)
            if nl > i:
                end = nl
        chunks.append(text[i:end])
        i = end
    return chunks


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def cmd_submit():
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
        if state.get("status") != "ended":
            print(f"Refusing to resubmit -- batch {state['batch_id']} already exists "
                  f"(status last seen: {state.get('status')}). Run --poll instead.")
            sys.exit(1)

    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    sources = sorted(f for f in os.listdir(SOURCES_DIR) if f.endswith(".txt"))
    if not sources:
        print(f"No .txt source files found in {SOURCES_DIR}. Nothing to submit.")
        sys.exit(1)

    id_map = {}
    requests = []
    for fname in sources:
        source_label = fname[:-4]  # filename sans .txt, e.g. "afh_glossary" -> used as a key only
        text = open(os.path.join(SOURCES_DIR, fname), encoding="utf-8").read()
        chunks = chunk_text(text)
        print(f"{fname}: {len(text)} chars -> {len(chunks)} chunks")
        for seq, chunk in enumerate(chunks):
            cid = f"{source_label}__{seq}"
            id_map[cid] = {"source_file": fname}
            requests.append(Request(
                custom_id=cid,
                params=MessageCreateParamsNonStreaming(
                    model=MODEL, max_tokens=4000, system=SYSTEM,
                    output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
                    messages=[{"role": "user", "content": chunk}],
                ),
            ))

    print(f"Total: {len(requests)} requests across {len(sources)} source file(s).")
    json.dump(id_map, open(ID_MAP_PATH, "w"))

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status, "created_at": time.time()}
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")


# meta.json per source file: {"source": "FAA-H-8083-3C ... Glossary", "category": "handbook"}
def source_meta(source_file):
    meta_path = os.path.join(SOURCES_DIR, source_file[:-4] + ".meta.json")
    if os.path.exists(meta_path):
        return json.load(open(meta_path))
    return {"source": source_file, "category": "handbook"}


def cmd_poll():
    if not os.path.exists(STATE_PATH):
        print("No batch state found -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Batch {batch.id}: {batch.processing_status}  "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored})")
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet. Re-run --poll later.")
        return

    id_map = json.load(open(ID_MAP_PATH))
    total_in = total_out = 0
    empty = errored = 0
    raw_count = 0
    # Keyed by lower(term) -- NOT source-prefixed. Multiple FAA handbooks
    # share a lot of core vocabulary (aerodynamics, regs), and a term
    # appearing in two source files in the SAME run used to get two
    # separately-slugged rows that never deduped against each other (only
    # a per-run `seen_slugs` guarded against repeats within one file).
    # Found live 2026-08-01: 444 duplicate terms, 503 redundant rows, e.g.
    # "Skin friction drag" as two rows from ifh_glossary + phak_real_glossary
    # in the same batch. Fixed by merging into one row per term here, with
    # senses/sources accumulated across every contributing source file.
    merged = {}
    for result in client.messages.batches.results(batch.id):
        cid = result.custom_id
        source_file = id_map[cid]["source_file"]
        if result.result.type != "succeeded":
            errored += 1
            continue
        msg = result.result.message
        total_in += msg.usage.input_tokens
        total_out += msg.usage.output_tokens
        text = next((b.text for b in msg.content if b.type == "text"), None)
        if not text:
            empty += 1
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            empty += 1
            continue
        meta = source_meta(source_file)
        for e in parsed.get("entries", []):
            term = e["term"].strip().rstrip(".")
            defn = e["definition"].strip()
            if not term or not defn:
                continue
            raw_count += 1
            key = term.lower()
            if key not in merged:
                merged[key] = {
                    "term": term,
                    "letter": term[0].upper() if term[0].isalpha() else "#",
                    "category": meta["category"],
                    "defs": [],  # list of (definition, source) so senses+source both merge
                }
            entry = merged[key]
            if defn.lower() not in {d.lower() for d, _ in entry["defs"]}:
                entry["defs"].append((defn, meta["source"]))

    all_rows = []
    for key, entry in merged.items():
        sources = list(dict.fromkeys(s for _, s in entry["defs"]))  # dedupe, keep order
        all_rows.append({
            "term": entry["term"],
            "slug": f"hb-{slugify(entry['term'])}",
            "letter": entry["letter"],
            "category": entry["category"],
            "senses": [{"definition": d, "usage": None} for d, _ in entry["defs"]],
            "source": "; ".join(sources),
        })

    cost = total_in / 1_000_000 * 1.0 + total_out / 1_000_000 * 5.0
    print(f"Parsed {raw_count} raw entries -> {len(all_rows)} merged terms from "
          f"{len(id_map) - errored - empty} successful chunks "
          f"({errored} errored, {empty} empty/unparseable). Actual cost: ${cost:.3f} "
          f"({total_in} in / {total_out} out tokens, Sonnet 5 batch rate).")

    # Skip terms already covered by an earlier tier (contractions/Appendix B/
    # an earlier prose-glossary run) -- case-insensitive, matching how the
    # merge above keys on lower(term).
    from author_fact_deck import mgmt_sql
    existing_terms = {r["term"].lower() for r in mgmt_sql("select term from dictionary_terms")}
    new_rows = [r for r in all_rows if r["term"].lower() not in existing_terms]
    print(f"{len(new_rows)} of {len(all_rows)} are new terms (rest already covered by an earlier tier).")

    BATCH = 500
    upserted = 0
    for i in range(0, len(new_rows), BATCH):
        chunk = new_rows[i:i + BATCH]
        status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status not in (200, 201, 204):
            print(f"  chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            upserted += len(chunk)
    print(f"Upserted {upserted} rows into dictionary_terms.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    args = ap.parse_args()
    os.makedirs(SOURCES_DIR, exist_ok=True)
    if args.submit:
        cmd_submit()
    elif args.poll:
        cmd_poll()
    else:
        ap.print_help()
