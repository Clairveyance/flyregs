#!/usr/bin/env python3
"""Classify per-item (per-FAR-section / per-AC-document / per-AIM-paragraph)
knowledge levels, via the Anthropic Batches API, to fix the "coarse tagging"
gap: far_knowledge_levels/ac_knowledge_levels/aim_knowledge_levels are pure
CASE-statement rule functions keyed on structural position (FAR part+
subpart, AC subject series, AIM chapter) -- every item under one subpart/
series/chapter gets the SAME cert-level array, so e.g. every AC in subject
series 91 (from a basic checklist to AC 91-84 "Fractional Ownership
Programs") shows to a Student-level filter identically. RC-greenlit
2026-08-22, real per-item scope confirmed live: 3,600 FAR sections + 715 AC
documents + 428 AIM paragraphs (every distinct item with a live study_facts
row -- items with zero facts never surface in Study/Duels regardless of
level tag, so classifying them would be pure waste).

SAFETY DESIGN -- this pass can only ever NARROW, never widen, the existing
coarse classification: each request's structured-output schema is built
with an `enum` constrained to that item's OWN current ceiling (the real
live output of far_knowledge_levels/ac_knowledge_levels/aim_knowledge_levels
for that item's part+subpart/series/chapter) -- the model is structurally
incapable of returning a level outside what a human already scoped at the
coarse level, so the worst-case failure mode is "still too coarse", never
"invented an inappropriate level". The prompt additionally instructs: when
genuinely unsure, return the full ceiling unchanged (conservative default --
protects against over-restricting the study pool, which was never the bug
being fixed).

Writes to far_section_levels / ac_doc_levels / aim_paragraph_levels (see
sync/migrations_far_ac_aim_per_item_knowledge_levels.sql for the schema and
for how far_all_levels/ac_all_levels/aim_all_levels now read these tables
first, falling back to the original coarse function for anything not yet
classified here).

Usage:
  python3 scripts/classify_knowledge_levels.py --submit --types=aim   # smallest, validate first
  python3 scripts/classify_knowledge_levels.py --poll --types=aim
  python3 scripts/classify_knowledge_levels.py --submit --types=far,aim,ac
  python3 scripts/classify_knowledge_levels.py --poll --types=far,aim,ac
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".knowledge_level_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".knowledge_level_id_map.json")
MODEL = "claude-sonnet-5"
MAX_BODY_CHARS = 4000  # classification needs far less context than authoring


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


SYSTEM_PROMPT = """You classify FAA regulatory content by which pilot/mechanic certificate level it's genuinely appropriate for someone to STUDY at, for a flashcard/quiz app.

The 6 possible levels: student (pre-solo/pre-checkride fundamentals, no certificate prerequisite), private (private pilot certificate scope), commercial (commercial pilot operations), atp (airline transport pilot / advanced, complex, or high-altitude ops), cfi (flight instructor -- teaching methodology, endorsements, instructional privileges/limits), mechanic (A&P mechanic / airworthiness / maintenance content).

You are given a CEILING -- the levels this content is currently allowed to appear under, already scoped by a human at the structural (part/series/chapter) level. Your ONLY job is to decide, from the actual text, whether every level in the ceiling still genuinely fits, or whether some should be dropped because the content is too advanced/narrow/out-of-scope for someone studying at that level. You may ONLY remove levels from the ceiling -- you can never add a level that isn't already in it.

Be CONSERVATIVE: if you're genuinely unsure whether a level belongs, KEEP it (return the ceiling unchanged). Only drop a level when the text is clearly, unambiguously out of scope for it -- e.g. a Category II/III instrument approach procedure is not 'student' or even baseline 'private' material; a fractional-ownership program's operational-control rules are not 'student' material; a basic VFR cruising-altitude rule IS appropriate for every level in a typical ceiling. Never drop every level to zero -- if the ceiling has 2+ levels and you're dropping some, always leave at least one.

Respond with JSON only: {"levels": [...]} using ONLY values from the given ceiling."""


def build_format(ceiling):
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "levels": {
                    "type": "array",
                    "items": {"type": "string", "enum": ceiling},
                    "minItems": 1,
                }
            },
            "required": ["levels"],
            "additionalProperties": False,
        },
    }


def fetch_sources(only_types):
    pools = {}
    if "far" in only_types:
        pools["far"] = mgmt_sql("""
            select f.section_number as item_id, f.title, f.body_text,
                   far_knowledge_levels(f.part, f.subpart_letter) as ceiling
            from far_sections f
            where f.body_text is not null and f.body_text <> ''
              and f.section_number in (
                select distinct item_id from study_facts where item_type = 'far' and status = 'live'
              )
              and f.section_number not in (select section_number from far_section_levels)
            order by f.section_number
        """)
    if "aim" in only_types:
        pools["aim"] = mgmt_sql("""
            select a.paragraph_number as item_id, a.title, a.body_text,
                   aim_knowledge_levels(a.chapter, a.paragraph_number) as ceiling
            from aim_paragraphs a
            where a.body_text is not null and a.body_text <> ''
              and a.paragraph_number in (
                select distinct item_id from study_facts where item_type = 'aim' and status = 'live'
              )
              and a.paragraph_number not in (select paragraph_number from aim_paragraph_levels)
            order by a.paragraph_number
        """)
    if "ac" in only_types:
        pools["ac"] = mgmt_sql("""
            select c.document_number as item_id, c.title, c.pdf_text as body_text,
                   ac_knowledge_levels(c.subject_series) as ceiling
            from advisory_circulars c
            where c.pdf_text is not null and length(c.pdf_text) > 200
              and c.document_number in (
                select distinct item_id from study_facts where item_type = 'ac' and status = 'live'
              )
              and c.document_number not in (select document_number from ac_doc_levels)
            order by c.document_number
        """)
    out = []
    for t in ["far", "aim", "ac"]:
        if t in pools:
            # skip items whose current ceiling is already a single level --
            # nothing to narrow, classifying would be pure wasted spend.
            out += [(t, r) for r in pools[t] if r["ceiling"] and len(r["ceiling"]) > 1]
    return out


LABEL_PREFIX = {"far": "FAR §", "aim": "AIM", "ac": "AC"}


def make_custom_id(item_type, seq):
    return f"{item_type}_{seq}"


def build_request(item_type, row, custom_id):
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    body = (row["body_text"] or "")[:MAX_BODY_CHARS]
    ceiling = row["ceiling"]
    label = f"{LABEL_PREFIX[item_type]} {row['item_id']}"
    user_content = (
        f"{label} — {row['title']}\nCEILING (only these levels are eligible): {ceiling}\n\n"
        f"BODY_TEXT:\n{body}"
    )
    return Request(
        custom_id=custom_id,
        params=MessageCreateParamsNonStreaming(
            model=MODEL,
            max_tokens=500,
            system=SYSTEM_PROMPT,
            output_config={"effort": "low", "format": build_format(ceiling)},
            messages=[{"role": "user", "content": user_content}],
        ),
    )


def _state_paths(only_types):
    suffix = f"_{'_'.join(sorted(only_types))}"
    return STATE_PATH.replace(".json", f"{suffix}.json"), ID_MAP_PATH.replace(".json", f"{suffix}.json")


def cmd_submit(only_types):
    state_path, id_map_path = _state_paths(only_types)

    if os.path.exists(state_path):
        state = json.load(open(state_path))
        if state.get("status") != "ended":
            print(f"Refusing to resubmit -- batch {state['batch_id']} already exists "
                  f"(status last seen: {state.get('status')}). Run --poll instead, or "
                  f"delete {state_path} if you're certain it's safe to resubmit.")
            sys.exit(1)

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    sources = fetch_sources(only_types)
    counts = {t: sum(1 for tt, _ in sources if tt == t) for t in ["far", "aim", "ac"]}
    print(f"Fetched {counts['far']} FAR + {counts['aim']} AIM + {counts['ac']} AC "
          f"items needing classification ({len(sources)} total, single-level-ceiling items already skipped).")

    if not sources:
        print("Nothing to classify.")
        return

    id_map = {}
    requests = []
    for seq, (t, r) in enumerate(sources):
        cid = make_custom_id(t, seq)
        id_map[cid] = {"item_type": t, "item_id": r["item_id"], "ceiling": r["ceiling"]}
        requests.append(build_request(t, r, cid))
    json.dump(id_map, open(id_map_path, "w"))

    total_input_chars = sum(len((r["body_text"] or "")[:MAX_BODY_CHARS]) for _, r in sources)
    est_input_tokens = total_input_chars // 4 + len(sources) * 200
    est_output_tokens = len(sources) * 40
    est_cost = est_input_tokens / 1_000_000 * 1.5 + est_output_tokens / 1_000_000 * 7.5
    print(f"Estimated ~{est_input_tokens:,} input / ~{est_output_tokens:,} output tokens, "
          f"~${est_cost:.2f} (batch-rate, Sonnet 5 intro pricing).")

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status,
              "item_count": len(sources), "created_at": time.time()}
    json.dump(state, open(state_path, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")
    print(f"State saved to {state_path}. Run --poll (same --types) to check progress / ingest when done.")


TABLE_FOR_TYPE = {
    "far": ("far_section_levels", "section_number"),
    "aim": ("aim_paragraph_levels", "paragraph_number"),
    "ac": ("ac_doc_levels", "document_number"),
}


def cmd_poll(only_types):
    state_path, id_map_path = _state_paths(only_types)

    if not os.path.exists(state_path):
        print(f"No batch state found at {state_path} -- run --submit first (with the same --types).")
        sys.exit(1)
    state = json.load(open(state_path))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Batch {batch.id}: {batch.processing_status}  "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored} "
          f"processing={batch.request_counts.processing})")

    state["status"] = batch.processing_status
    json.dump(state, open(state_path, "w"), indent=2)

    if batch.processing_status != "ended":
        print("Not done yet. Re-run --poll later.")
        return

    id_map = json.load(open(id_map_path))

    rows_by_table = {"far": [], "aim": [], "ac": []}
    accepted, empty, shape_rejected, errored = 0, 0, 0, 0
    narrowed = 0
    total_in_tok, total_out_tok = 0, 0

    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            errored += 1
            continue
        msg = result.result.message
        total_in_tok += msg.usage.input_tokens
        total_out_tok += msg.usage.output_tokens
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            shape_rejected += 1
            continue
        levels = parsed.get("levels")
        mapped = id_map.get(result.custom_id)
        if not mapped:
            shape_rejected += 1
            continue
        item_type, item_id, ceiling = mapped["item_type"], mapped["item_id"], mapped["ceiling"]
        # Defensive: schema enum already constrains this, but never trust a
        # single layer -- an empty/invalid response falls back to the full
        # ceiling (the safe, pre-existing behavior) rather than being
        # dropped or, worse, written as an empty array that would hide the
        # item from every level filter.
        if not isinstance(levels, list) or not levels or not set(levels) <= set(ceiling):
            levels = ceiling
            empty += 1
        else:
            accepted += 1
            if set(levels) < set(ceiling):
                narrowed += 1
        table, key = TABLE_FOR_TYPE[item_type]
        rows_by_table[item_type].append({key: item_id, "levels": levels, "model": MODEL})

    print(f"\nParsed {batch.request_counts.succeeded} responses: {accepted} classified normally "
          f"({narrowed} genuinely narrowed from ceiling), {empty} fell back to full ceiling "
          f"(invalid/empty model output), {shape_rejected} unmapped, {errored} request errors.")

    cost = total_in_tok / 1_000_000 * 1.5 + total_out_tok / 1_000_000 * 7.5
    print(f"Actual usage: {total_in_tok:,} input / {total_out_tok:,} output tokens "
          f"-> ~${cost:.2f} at Sonnet 5 batch rate.")

    total_written = 0
    for item_type, rows in rows_by_table.items():
        if not rows:
            continue
        table, key = TABLE_FOR_TYPE[item_type]
        for i in range(0, len(rows), 500):
            chunk = rows[i:i + 500]
            status, body = rest("POST", f"/rest/v1/{table}?on_conflict={key}",
                                 body=chunk, prefer="resolution=merge-duplicates,return=minimal")
            if status >= 300:
                print(f"  insert chunk into {table} at {i}: HTTP {status}: {str(body)[:300]}")
            else:
                total_written += len(chunk)
    print(f"Wrote {total_written} rows across far_section_levels/aim_paragraph_levels/ac_doc_levels.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--types", default="far,aim,ac")
    args = ap.parse_args()
    only_types = sorted(set(args.types.split(",")))

    if args.submit:
        cmd_submit(only_types)
    elif args.poll:
        cmd_poll(only_types)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
