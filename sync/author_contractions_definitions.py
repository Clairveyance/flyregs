#!/usr/bin/env python3
"""Write real descriptive definitions for the FAA JO 7340.2P (Contractions)
dictionary source, which today stores only the bare acronym expansion (RC,
support email 2026-08-26: "tells you what the acronym means but it doesn't
describe what it is... should apply to all dictionary definitions in the
corpus" -- scoped down to this one source, since it's the one actually at
fault: 3,242 of 3,282 Contractions entries have a <=60-char definition,
because that source IS just a contractions list, not a definitions
dictionary. Every other dictionary source (NOAA Glossary, the FAA handbook
glossaries) is already properly descriptive -- confirmed via a corpus-wide
scoping query before writing this, along with confirming there's no free
fix (only 1 of 3,242 has a richer definition elsewhere in the corpus under
the same term, so cross-source merging isn't viable).

20-term live test (2026-08-26, not this script -- a one-off sync call)
validated the approach: $0.01046 real cost, correctly left plain-English
contractions (THDR->"Thunder", SM->"Statute mile") unchanged rather than
padding them, wrote accurate real definitions for genuine acronyms (RAIM,
PNR, RVRA, RPS, NAAS), and self-flagged 4/20 (20%) "unsure" on genuinely
ambiguous ones (ALDA, ALANO, MUA, DOLLY) instead of confidently guessing.
RC approved the full run + the ~$0.85 Batches-API estimate on that basis.

Two-tier write, since ~20% "unsure" extrapolates to ~650 terms that
shouldn't go live without a human read: confident (unsure=false) results
write straight to dictionary_terms.senses on --poll; unsure=true results
are held in a review file (not written) for a separate manual pass -- see
--poll's own printed instructions.

SAFETY: never run --submit twice concurrently -- see
memory/gotcha_double_background_process.md. Refuses to resubmit if a
non-terminal batch is already tracked.

Usage:
  python3 sync/author_contractions_definitions.py --submit
  python3 sync/author_contractions_definitions.py --poll
"""
import argparse, json, os, sys, time, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "sync", ".contractions_defs_batch_state.json")
RESULTS_PATH = os.path.join(BASE, "sync", ".contractions_defs_results.json")
REVIEW_PATH = os.path.join(BASE, "sync", ".contractions_defs_unsure_review.json")
MODEL = "claude-haiku-4-5-20251001"
CHUNK_SIZE = 40  # ~2x the validated 20-term test batch; comfortable margin under any output-length risk


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


SCRAPER = load_env(".env.scraper")
SUPABASE_URL, SERVICE_KEY = SCRAPER["SUPABASE_URL"], SCRAPER["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}

SYSTEM = """You write real, accurate descriptive definitions for aviation/ATC/weather abbreviation entries, to replace bare letter-by-letter expansions with an actual explanation of what the thing IS or DOES.

Each input entry has a term (the abbreviation), its usage context (ATC/ICAO/NWS/GEN), and its current stored "definition" -- today that's often just the expanded words, not a real definition (e.g. "RAIM" -> "Receiver Autonomous Integrity Monitoring" tells you what the letters stand for but not what RAIM actually does).

For each sense of each term, decide:
- If the current text is already a plain, ordinary English word or short phrase that needs NO further aviation-specific explanation (e.g. "Thunder", "sometime", "Velocity", "round trip", "south plains") -- these are genuine contractions of ordinary words, not real acronyms needing a definition. For these, set changed=false and definition=the original text unchanged (only fix obvious capitalization).
- If the term is a real acronym, system name, procedure, or aviation-specific concept where knowing the expansion alone doesn't tell you what it actually is (e.g. RAIM, PNR, MUA, NAAS, ALDA) -- write ONE clear, factually accurate sentence (rarely two) explaining what it actually is or does in real aviation/ATC/weather use, grounded in genuine knowledge of the subject. Do not invent specifics you're not confident about. Set changed=true.
- If you are not fully confident the definition you wrote is factually accurate, set unsure=true so it can be human-reviewed -- never guess at technical specifics (frequencies, exact regulatory authorities, precise operational thresholds) you aren't sure of.

Keep definitions concise -- one real sentence, not a paragraph. Respond with JSON only, matching the schema."""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "senses": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "usage": {"type": "string"},
                                "definition": {"type": "string"},
                                "changed": {"type": "boolean"},
                                "unsure": {"type": "boolean"},
                            },
                            "required": ["usage", "definition", "changed", "unsure"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["term", "senses"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}


def fetch_targets():
    """Same population as the scoping query used before this script existed:
    Contractions-sourced entries with a <=60-char first-sense definition."""
    out, offset = [], 0
    while True:
        url = (f"{SUPABASE_URL}/rest/v1/dictionary_terms"
               f"?select=slug,term,senses&source=eq.FAA%20JO%207340.2P%20(Contractions)"
               f"&limit=1000&offset={offset}&order=slug.asc")
        req = urllib.request.Request(url, headers=HEADERS)
        rows = json.loads(urllib.request.urlopen(req).read())
        if not rows:
            break
        for r in rows:
            d = (r["senses"][0] or {}).get("definition") if r["senses"] else None
            if d is not None and len(d) <= 60:
                out.append(r)
        offset += 1000
    return out


def chunk(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]


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

    targets = fetch_targets()
    print(f"Found {len(targets)} target terms (Contractions source, <=60-char definition).")

    chunks = list(chunk(targets, CHUNK_SIZE))
    id_map = {}
    requests = []
    for i, ch in enumerate(chunks):
        custom_id = f"chunk_{i}"
        id_map[custom_id] = [{"slug": t["slug"], "term": t["term"], "senses": t["senses"]} for t in ch]
        payload = [{"term": t["term"], "senses": [{"usage": s["usage"], "definition": s["definition"]} for s in t["senses"]]} for t in ch]
        requests.append(Request(
            custom_id=custom_id,
            params=MessageCreateParamsNonStreaming(
                model=MODEL,
                max_tokens=6000,  # generous headroom -- see author_fact_deck.py's own documented
                                  # silent-truncation gotcha with structured/tool-forced output
                system=SYSTEM,
                tools=[{"name": "submit_definitions", "description": "Submit the rewritten definitions.", "input_schema": SCHEMA}],
                tool_choice={"type": "tool", "name": "submit_definitions"},
                messages=[{"role": "user", "content": json.dumps(payload)}],
            ),
        ))

    batch = client.messages.batches.create(requests=requests)
    json.dump({"batch_id": batch.id, "status": batch.processing_status, "chunk_count": len(chunks), "term_count": len(targets)},
               open(STATE_PATH, "w"), indent=2)
    json.dump(id_map, open(STATE_PATH.replace("batch_state", "id_map"), "w"))
    print(f"Submitted batch {batch.id}: {len(chunks)} requests, {len(targets)} terms. Run --poll to check status.")


def cmd_poll():
    if not os.path.exists(STATE_PATH):
        print("No batch submitted yet -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))
    id_map = json.load(open(STATE_PATH.replace("batch_state", "id_map")))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    print(f"Batch {batch.id}: {batch.processing_status}  "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored} "
          f"processing={batch.request_counts.processing})")

    if batch.processing_status != "ended":
        print("Not done yet -- run --poll again later.")
        return

    confident_updates = []  # [{slug, term, senses}] -- ready to write
    unsure_review = []      # [{slug, term, senses, original_senses}] -- needs a human read first
    errors = []

    for result in client.messages.batches.results(state["batch_id"]):
        custom_id = result.custom_id
        orig_items = {t["term"]: t for t in id_map.get(custom_id, [])}
        if result.result.type != "succeeded":
            errors.append({"custom_id": custom_id, "type": result.result.type})
            continue
        msg = result.result.message
        tool_use = next((b for b in msg.content if b.type == "tool_use"), None)
        if not tool_use:
            errors.append({"custom_id": custom_id, "type": "no_tool_use"})
            continue
        raw_results = tool_use.input.get("results", [])
        if isinstance(raw_results, str):
            # Rare structured-output quirk (seen on 1/82 chunks): the model
            # emitted "results" as a JSON-encoded string instead of a true
            # nested array -- no strict:true was set on the tool schema, so
            # this wasn't hard-enforced. Recover by parsing it.
            try:
                raw_results = json.loads(raw_results)
            except json.JSONDecodeError:
                errors.append({"custom_id": custom_id, "type": "unparseable_results_string"})
                continue
        for r in raw_results:
            if not isinstance(r, dict) or "term" not in r:
                errors.append({"custom_id": custom_id, "type": "malformed_result_item"})
                continue
            orig = orig_items.get(r["term"])
            if not orig:
                continue
            any_unsure = any(s.get("unsure") for s in r["senses"])
            new_senses = [{"usage": s["usage"], "definition": s["definition"]} for s in r["senses"]]
            entry = {"slug": orig["slug"], "term": orig["term"], "senses": new_senses, "original_senses": orig["senses"]}
            (unsure_review if any_unsure else confident_updates).append(entry)

    print(f"\nParsed: {len(confident_updates)} confident, {len(unsure_review)} unsure (need review), {len(errors)} errors.")
    if errors:
        print(f"Errors: {errors[:10]}{'...' if len(errors) > 10 else ''}")

    json.dump(unsure_review, open(REVIEW_PATH, "w"), indent=2)
    print(f"\nWrote {len(unsure_review)} unsure entries to {REVIEW_PATH} for manual review -- NOT written to the DB.")

    if not confident_updates:
        print("Nothing confident to write.")
        return

    print(f"\nWriting {len(confident_updates)} confident updates to dictionary_terms...")
    ok, fail = 0, 0
    for entry in confident_updates:
        url = f"{SUPABASE_URL}/rest/v1/dictionary_terms?slug=eq.{urllib.parse.quote(entry['slug'])}"
        req = urllib.request.Request(url, data=json.dumps({"senses": entry["senses"]}).encode(),
                                      headers={**HEADERS, "Prefer": "return=minimal"}, method="PATCH")
        try:
            urllib.request.urlopen(req)
            ok += 1
        except Exception as e:
            fail += 1
            print(f"  FAILED {entry['slug']}: {e}")
    print(f"\nDone: {ok} written, {fail} failed.")
    json.dump(confident_updates, open(RESULTS_PATH, "w"), indent=2)
    print(f"Full record of what was written: {RESULTS_PATH}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--submit", action="store_true")
    p.add_argument("--poll", action="store_true")
    args = p.parse_args()
    if args.submit:
        cmd_submit()
    elif args.poll:
        cmd_poll()
    else:
        p.print_help()
