#!/usr/bin/env python3
"""Author the FAR + AIM fact-recall deck (study_facts table) via the
Anthropic Batches API.

RC's contract (2026-07-31): "The Q has to be one short, single sentence or
phrase. the A should just be a reg name or number... a good Q/A example:
Q: What is the typical vertical limit of Class C airspace?
A: surface to 4,000 feet AGL above the airport (charted as MSL)."

Scope + pricing (Option B, approved 2026-07-31): see
PROJECT_NOTES/flyregs_fact_deck_scope.md. FAR (study_far_sections pool,
3,607 items) + AIM (436 items) authored on Sonnet 5 via the Batches API
(50% off list). A SEPARATE verification pass (--verify, run on Haiku after
RC switches models) grades each authored card against its source text and
promotes pending -> live or flags it.

SAFETY: never run --submit twice concurrently -- see
memory/gotcha_double_background_process.md (a prior double-background run
doubled a paid extraction's cost for ~1hr before it was caught). This
script refuses to resubmit if scripts/.fact_deck_batch_state.json already
names a non-terminal batch; use --poll to check on it instead.

Usage:
  python3 scripts/author_fact_deck.py --submit        # one-time: build + submit the batch
  python3 scripts/author_fact_deck.py --poll           # check status / ingest results when done
  python3 scripts/author_fact_deck.py --verify         # second pass: grade pending facts (run on Haiku)
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".fact_deck_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".fact_deck_id_map.json")
AUTHOR_MODEL = "claude-sonnet-5"
VERIFY_MODEL = "claude-sonnet-5"  # RC 2026-07-31: "we're fine staying in Sonnet for the verification"
MAX_BODY_CHARS = 8000  # caps outlier sections (e.g. big appendices) without hurting typical items


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
    """Run SQL via the Supabase Management API -- full JSON result, unlike
    apply_migration.py which truncates its printed output at 2000 chars."""
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


SYSTEM_PROMPT = """You write short fact-recall flashcards from FAA regulatory text, for a pilot study app.

CONTRACT (do not deviate):
- Question: ONE short sentence or phrase, ending in "?", under 140 characters. It asks about a CONCRETE fact stated in the text -- a number, limit, distance, altitude, time period, threshold, or named requirement. Never a vague "what does this section require?" framing.
- Answer: a short factual PHRASE, not a full sentence. Under 90 characters.
- source_quote: copy the EXACT contiguous span of the provided BODY_TEXT (character-for-character, no paraphrasing) that supports your answer. This is used to programmatically verify you didn't invent the fact.

STYLE STEER (2026-07-31, from researching the FAA's own released Private Pilot-Airplane (PAR)
sample test questions -- see PROJECT_NOTES/flyregs_session_2026_07_31.md "test-prep question-style
research" checkpoint): real FAA test questions are overwhelmingly SCENARIO-TO-THRESHOLD, not
citation-to-fact. Frame the question around a concrete operational situation or condition, and make
the answer the specific number/procedure/threshold that applies in that situation -- not a bare
restatement of what the section says. Favor this shape over administrative or citation-heavy facts
(who-must-file-what, section-cross-reference trivia) whenever the passage supports it.

Real FAA examples of the target shape (public domain, FAA-published PAR sample questions):
Q: "During operations outside controlled airspace at altitudes more than 1,200 feet AGL but less than 10,000 feet MSL, what is the minimum flight visibility for day VFR flight?"
A: "1 statute mile"
Q: "How should a pilot state an assigned altitude of 5,500 feet MSL to ATC?"
A: "five thousand five hundred"
Q: "Unless otherwise authorized, when is two-way radio communication with ATC required for landings or takeoffs at a towered airport?"
A: "regardless of weather conditions"
Q: "What is the typical vertical limit of Class C airspace?"
A: "surface to 4,000 feet AGL above the airport (charted as MSL)"

Return 1 to 3 facts, prioritizing quality over quantity -- most passages should yield exactly one. If the passage has NO clean extractable fact (pure cross-reference, "[Reserved]", purely administrative or definitional boilerplate with nothing quiz-worthy), return an EMPTY facts array. Do not invent a question just to have something to return.

Respond with JSON only, matching the schema."""

FACT_FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "facts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string"},
                        "answer": {"type": "string"},
                        "source_quote": {"type": "string"},
                    },
                    "required": ["question", "answer", "source_quote"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["facts"],
        "additionalProperties": False,
    },
}


def fetch_sources(only_types=None):
    pools = {}
    if only_types is None or "far" in only_types:
        pools["far"] = mgmt_sql("""
            select f.section_number as item_id, f.title, f.body_text
            from far_sections f
            join study_far_sections s on s.section_number = f.section_number
            order by f.section_number
        """)
    if only_types is None or "aim" in only_types:
        pools["aim"] = mgmt_sql("""
            select paragraph_number as item_id, title, body_text
            from aim_paragraphs
            where body_text is not null and body_text <> ''
              and title is not null and title <> '' and title not ilike '%[reserved%'
            order by paragraph_number
        """)
    # AC/P-CG extension (2026-08-01, RC: "yes redo the quiz gen sample... then
    # if so, build it out" -- FAR/AIM already have real study_facts coverage
    # (13,560 + 2,174 live), AC and P/CG had zero. Unlike FAR/AIM's full
    # section/paragraph body_text, AC uses `description` (the same short
    # official abstract already used for DailyReg's AC rotation, not the
    # full PDF/blocks -- consistent with RC's earlier "keep them simple"
    # scoping for AC content) and P/CG uses `definition`, its own natural
    # atomic unit (arguably even better-suited to this pipeline than FAR/AIM
    # since a P/CG term is already a single self-contained definition).
    if only_types is None or "ac" in only_types:
        pools["ac"] = mgmt_sql("""
            select document_number as item_id, title, description as body_text
            from advisory_circulars
            where status = 'active' and description is not null and description <> ''
            order by document_number
        """)
    if only_types is None or "pcg" in only_types:
        pools["pcg"] = mgmt_sql("""
            select slug as item_id, term as title, definition as body_text
            from pcg_terms
            where definition is not null and definition <> ''
            order by slug
        """)
    out = []
    for t in ["far", "aim", "ac", "pcg"]:
        if t in pools:
            out += [(t, r) for r in pools[t]]
    return out


def make_custom_id(item_type, item_id, seq):
    # Batches custom_id must match ^[a-zA-Z0-9_-]{1,64}$ -- FAR section
    # numbers contain dots ("91.155"), so it can't just be "type:item_id".
    # `seq` guarantees uniqueness; the real (item_type, item_id) is kept in
    # ID_MAP_PATH rather than round-tripped through the string.
    return f"{item_type}_{seq}"


LABEL_PREFIX = {"far": "FAR §", "aim": "AIM", "ac": "AC", "pcg": "P/CG"}


def build_request(item_type, row, custom_id):
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    body = (row["body_text"] or "")[:MAX_BODY_CHARS]
    label = f"{LABEL_PREFIX[item_type]} {row['item_id']}"
    user_content = f"{label} — {row['title']}\n\nBODY_TEXT:\n{body}"
    return Request(
        custom_id=custom_id,
        params=MessageCreateParamsNonStreaming(
            model=AUTHOR_MODEL,
            # Was 700 -- confirmed live (2026-08-01, testing the AC/P-CG
            # extension) that this has the SAME bug already diagnosed and
            # fixed for the verify pass below (Sonnet 5's adaptive thinking
            # is on by default and shares max_tokens with the actual
            # response): a direct sample against real AC/P-CG rows using
            # this exact request shape got a >80% silent-failure rate at
            # 700 AND at 1500 (stop_reason=max_tokens, zero text emitted,
            # zero facts recorded) -- the structured `output_config` json_schema
            # constraint appears to make the model think measurably more
            # before committing to output than an unconstrained call does.
            # Real successful responses only used 200-400 output tokens
            # total; 3000 leaves generous headroom for the observed
            # per-request variance (17 to 1500+ thinking tokens on
            # near-identical inputs) at zero extra cost, since billing is
            # actual-usage, not the cap. This same silent-failure shape
            # likely affected an unknown fraction of the original FAR/AIM
            # batch too (absorbed into the `empty`/`errored` counters in
            # --poll without anyone diagnosing WHY) -- not re-run, since
            # those items are long since live and re-authoring would cost
            # real money to reproduce facts that already exist.
            max_tokens=3000,
            system=SYSTEM_PROMPT,
            output_config={"effort": "medium", "format": FACT_FORMAT},
            messages=[{"role": "user", "content": user_content}],
        ),
    )


def _state_paths(only_types):
    # The ORIGINAL far+aim batch's state/id-map files have no suffix --
    # keep resolving to those exact paths for that exact type set so
    # nothing about the already-completed, already-live batch's records
    # changes. Any OTHER type combination (ac, pcg, or a mix) gets its own
    # suffixed files, so it can never collide with, resubmit over, or lose
    # track of that original batch.
    if sorted(only_types) == ["aim", "far"]:
        return STATE_PATH, ID_MAP_PATH
    suffix = f"_{'_'.join(sorted(only_types))}"
    return STATE_PATH.replace(".json", f"{suffix}.json"), ID_MAP_PATH.replace(".json", f"{suffix}.json")


def cmd_submit(only_types=None):
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
    counts = {t: sum(1 for tt, _ in sources if tt == t) for t in ["far", "aim", "ac", "pcg"]}
    print(f"Fetched {counts['far']} FAR + {counts['aim']} AIM + {counts['ac']} AC + {counts['pcg']} P/CG "
          f"source items ({len(sources)} total).")

    id_map = {}
    requests = []
    for seq, (t, r) in enumerate(sources):
        cid = make_custom_id(t, r["item_id"], seq)
        id_map[cid] = {"item_type": t, "item_id": r["item_id"]}
        requests.append(build_request(t, r, cid))
    json.dump(id_map, open(id_map_path, "w"))

    total_input_chars = sum(len((r["body_text"] or "")[:MAX_BODY_CHARS]) for _, r in sources)
    est_input_tokens = total_input_chars // 4 + len(sources) * 150  # ~150 tok/item system+wrapper overhead
    est_cost = est_input_tokens / 1_000_000 * 1.0 + len(sources) * 200 / 1_000_000 * 5.0  # batch rate, ~200 out tok/item est
    print(f"Estimated ~{est_input_tokens:,} input tokens, ~${est_cost:.2f} (batch-rate, Sonnet 5 intro pricing).")

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status,
             "item_count": len(sources), "created_at": time.time()}
    json.dump(state, open(state_path, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")
    print(f"State saved to {state_path}. Run --poll (same --types) to check progress / ingest when done.")


def normalize_ws(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def cmd_poll(only_types=None):
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
    # Need source body_text again for grounding checks -- refetch (cheap),
    # keyed by (item_type, item_id) since that's what id_map gives us.
    sources = {(t, r["item_id"]): r for t, r in fetch_sources(only_types)}

    accepted, rejected_ungrounded, rejected_shape, empty, errored = 0, 0, 0, 0, 0
    total_in_tok, total_out_tok = 0, 0
    rows = []
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
        src_body_norm = normalize_ws(src["body_text"]) if src else ""
        for fact in facts[:3]:
            q, a, quote = fact.get("question", ""), fact.get("answer", ""), fact.get("source_quote", "")
            if not (q.strip().endswith("?") and 8 <= len(q) <= 160 and 1 <= len(a) <= 110):
                rejected_shape += 1
                continue
            if normalize_ws(quote) not in src_body_norm:
                rejected_ungrounded += 1
                continue
            accepted += 1
            rows.append({
                "item_type": item_type, "item_id": item_id,
                "question": q.strip(), "answer": a.strip(), "source_quote": quote.strip(),
                "status": "pending", "model": AUTHOR_MODEL,
            })

    print(f"\nParsed {batch.request_counts.succeeded} responses: "
          f"{accepted} facts accepted, {empty} items had no extractable fact, "
          f"{rejected_shape} rejected (shape/length), {rejected_ungrounded} rejected (ungrounded quote), "
          f"{errored} request errors.")

    # batch rate = 50% of list price
    cost = total_in_tok / 1_000_000 * 1.0 + total_out_tok / 1_000_000 * 5.0
    print(f"Actual usage: {total_in_tok:,} input / {total_out_tok:,} output tokens "
          f"-> ~${cost:.2f} at Sonnet 5 batch rate (intro pricing through 2026-08-31).")

    if not rows:
        print("Nothing to insert.")
        return

    inserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        status, body = rest("POST", "/rest/v1/study_facts?on_conflict=item_type,item_id,question",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status >= 300:
            print(f"  insert chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            inserted += len(chunk)
    print(f"Inserted/upserted {inserted} rows into study_facts (status=pending).")
    print("Authoring complete. Run --verify (on Haiku) to grade and promote to status=live.")


VERIFY_SYSTEM = """You fact-check a flashcard against its source regulatory text.

Given SOURCE_TEXT, a QUESTION, and an ANSWER, decide whether the answer is factually
correct and directly supported by the source text. Respond with JSON only:
{"verdict": "pass" | "fail", "corrected_answer": string or null}

"pass": the answer is accurate and grounded in the source text as written.
"fail": the answer is wrong, unsupported, or misleading. If a small, precise
correction would fix it, include it as corrected_answer (same short-phrase style
as the original answer); otherwise corrected_answer is null and the card should
be discarded."""

VERIFY_FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "verdict": {"type": "string", "enum": ["pass", "fail"]},
            "corrected_answer": {"type": ["string", "null"]},
        },
        "required": ["verdict", "corrected_answer"],
        "additionalProperties": False,
    },
}


def rest_get_all(path):
    """PostgREST silently caps unfiltered .select() at 1000 rows -- see
    memory/gotcha_postgrest_1000_row_cap.md (bit this project 3x already
    before this). Page with Range headers until a page comes back short."""
    out, offset, page = [], 0, 1000
    while True:
        req = urllib.request.Request(SUPABASE_URL + path, method="GET")
        req.add_header("apikey", SERVICE_KEY)
        req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
        req.add_header("Range", f"{offset}-{offset + page - 1}")
        with urllib.request.urlopen(req, timeout=60) as r:
            chunk = json.loads(r.read().decode())
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def cmd_verify():
    """Second pass: grade every status='pending' fact against its source text,
    on a model chosen by RC per-run (see VERIFY_MODEL). Promotes pass -> live,
    applies corrected_answer when offered, discards the rest (never live)."""
    pending = rest_get_all("/rest/v1/study_facts?status=eq.pending&select=id,item_type,item_id,question,answer,source_quote")
    if not pending:
        print("No pending facts to verify.")
        return
    print(f"Verifying {len(pending)} pending facts on {VERIFY_MODEL}...")

    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    requests = []
    for row in pending:
        content = (f"SOURCE_TEXT:\n{row['source_quote']}\n\n"
                   f"QUESTION: {row['question']}\nANSWER: {row['answer']}")
        requests.append(Request(
            custom_id=row["id"],
            params=MessageCreateParamsNonStreaming(
                # 200 was too tight: Sonnet 5 has adaptive thinking ON BY
                # DEFAULT and max_tokens caps thinking + response TOGETHER --
                # confirmed live as a real bug, 451 of 8535 verify calls
                # (~5%) spent their whole budget on thinking, hit
                # stop_reason=max_tokens with zero text emitted, and their
                # facts silently stayed status='pending' forever (no crash,
                # just quietly never verified). 1024 leaves real headroom.
                model=VERIFY_MODEL, max_tokens=1024, system=VERIFY_SYSTEM,
                output_config={"format": VERIFY_FORMAT},
                messages=[{"role": "user", "content": content}],
            ),
        ))

    batch = client.messages.batches.create(requests=requests)
    print(f"Verify batch submitted: {batch.id}. Poll manually with the SDK, or re-run "
          f"this command later -- it will look up {batch.id} once you paste it in "
          f"as VERIFY_BATCH_ID below and resume with --verify-poll.")
    json.dump({"verify_batch_id": batch.id, "count": len(pending)},
               open(os.path.join(BASE, "scripts", ".fact_deck_verify_state.json"), "w"), indent=2)


def cmd_verify_poll():
    vstate_path = os.path.join(BASE, "scripts", ".fact_deck_verify_state.json")
    if not os.path.exists(vstate_path):
        print("No verify batch in progress -- run --verify first.")
        sys.exit(1)
    vstate = json.load(open(vstate_path))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])
    batch = client.messages.batches.retrieve(vstate["verify_batch_id"])
    print(f"Verify batch {batch.id}: {batch.processing_status} "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored})")
    if batch.processing_status != "ended":
        return

    passed, corrected, failed, skipped = 0, 0, 0, 0
    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            skipped += 1
            continue
        msg = result.result.message
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            parsed = json.loads(text) if text else {}
        except json.JSONDecodeError:
            parsed = {}
        if not parsed:
            # No parseable verdict (e.g. hit max_tokens before emitting any
            # text). Leave it 'pending' rather than silently vanishing from
            # both the passed/corrected/failed counts AND the DB status --
            # confirmed live as the exact bug that left 451 facts stuck
            # pending forever with no visible sign anything went wrong.
            # Re-running --verify will pick these back up.
            skipped += 1
            continue
        fact_id = result.custom_id
        if parsed.get("verdict") == "pass":
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "live", "verified_at": "now()", "verified_model": VERIFY_MODEL})
            passed += 1
        elif parsed.get("corrected_answer"):
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "live", "answer": parsed["corrected_answer"],
                       "verified_at": "now()", "verified_model": VERIFY_MODEL})
            corrected += 1
        else:
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "flagged", "verified_at": "now()", "verified_model": VERIFY_MODEL})
            failed += 1
    print(f"Verification done: {passed} passed as-is, {corrected} corrected+passed, "
          f"{failed} flagged (never served), {skipped} left pending (no parseable "
          f"verdict -- re-run --verify to retry these).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--verify-poll", action="store_true")
    ap.add_argument("--types", default="far,aim",
                     help="comma-separated subset of far,aim,ac,pcg (default: far,aim -- matches "
                          "the ORIGINAL batch's scope exactly, never silently widens it). Use the "
                          "SAME --types for --submit and its --poll. Pass --types=ac,pcg explicitly "
                          "for the AC/P-CG extension -- it gets its own state files either way.")
    args = ap.parse_args()
    types = args.types.split(",")
    if args.submit:
        cmd_submit(types)
    elif args.poll:
        cmd_poll(types)
    elif args.verify:
        cmd_verify()
    elif args.verify_poll:
        cmd_verify_poll()
    else:
        print(__doc__)
