#!/usr/bin/env python3
"""Author the expanded question bank (study_facts, deepened) via the
Anthropic Batches API. Forked from author_fact_deck.py (same proven safety
mechanisms: double-submit guard, batch state files, grounding verification,
separate verify pass) rather than editing that file in place, since it's
the live-tested pipeline behind 16,000+ already-verified facts and
shouldn't be risked -- this fork changes three things:

1. Yield: 4-8 facts/item instead of 1-3 ("huge bank" depth, RC 2026-08-11).
2. Distractors: each fact now also gets 3 plausible wrong answers, authored
   in the SAME call (same source-grounding context available), so Duels can
   pull real questions instead of raw titles (task depends on this).
3. AC source: pdf_text (real, full document body) instead of description
   (a ~293-char FAA boilerplate blurb) -- this was the actual root cause of
   AC questions reading as bare titles/citation-trivia. Truncated to the
   same MAX_BODY_CHARS=8000 already used for every type (RC's approved,
   cost-reduced scope: ~$72 total vs ~$88 for untruncated AC).

Approved scope + price (RC, 2026-08-11): FAR ~$44, AIM ~$5, AC(truncated)
~$11 = ~$72 total. SAME safety discipline as the original: never run
--submit twice concurrently (see memory/gotcha_double_background_process.md).

Usage:
  python3 scripts/author_question_bank.py --submit --types=aim   # smallest/cheapest, validate first
  python3 scripts/author_question_bank.py --poll --types=aim
  python3 scripts/author_question_bank.py --submit --types=far,aim,ac  # full approved run
  python3 scripts/author_question_bank.py --poll --types=far,aim,ac
  python3 scripts/author_question_bank.py --verify
  python3 scripts/author_question_bank.py --verify-poll
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".question_bank_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".question_bank_id_map.json")
AUTHOR_MODEL = "claude-sonnet-5"
VERIFY_MODEL = "claude-haiku-4-5-20251001"
MAX_BODY_CHARS = 8000


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


SYSTEM_PROMPT = """You write fact-recall flashcards AND their multiple-choice distractors from FAA regulatory text, for a pilot study/duel app.

CONTRACT (do not deviate):
- Question: ONE short sentence or phrase, ending in "?", under 140 characters. It asks about a CONCRETE fact stated in the text -- a number, limit, distance, altitude, time period, threshold, or named requirement. Never a vague "what does this section require?" framing.
- Answer: a short factual PHRASE, not a full sentence. Under 90 characters.
- distractors: exactly 3 plausible-but-WRONG answers in the SAME shape/format/units as the real answer (e.g. if the answer is a distance in feet, distractors are other plausible distances in feet, not a different unit or a non-numeric answer). A distractor must be clearly, unambiguously wrong to someone who actually knows the source text -- never a second technically-correct phrasing of the same right answer, never something so implausible it gives itself away by being silly.
- source_quote: copy the EXACT contiguous span of the provided BODY_TEXT (character-for-character, no paraphrasing) that supports your answer. This is used to programmatically verify you didn't invent the fact.

STYLE STEER (from researching the FAA's own released Private Pilot-Airplane (PAR) sample test
questions): real FAA test questions are overwhelmingly SCENARIO-TO-THRESHOLD, not citation-to-fact.
Frame the question around a concrete operational situation or condition, and make the answer the
specific number/procedure/threshold that applies -- not a bare restatement of what the section says,
and never just the document's own title standing in as a question. Favor this shape over
administrative or citation-heavy facts (who-must-file-what, section-cross-reference trivia,
document-history trivia like "what AC did this replace") whenever the passage supports it.

Real FAA examples of the target shape (public domain, FAA-published PAR sample questions):
Q: "During operations outside controlled airspace at altitudes more than 1,200 feet AGL but less than 10,000 feet MSL, what is the minimum flight visibility for day VFR flight?"
A: "1 statute mile"
Q: "How should a pilot state an assigned altitude of 5,500 feet MSL to ATC?"
A: "five thousand five hundred"
Q: "What is the typical vertical limit of Class C airspace?"
A: "surface to 4,000 feet AGL above the airport (charted as MSL)"

Return 4 to 8 DISTINCT facts covering different concrete points in the passage (not near-duplicate
rephrasings of the same fact) -- fewer only if the passage genuinely doesn't support that many
distinct extractable facts (a short or purely administrative passage may yield fewer, or zero; never
invent facts or near-duplicates just to hit a count).

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
                        # minItems/maxItems > 1 aren't supported by the
                        # structured-output schema validator (confirmed live,
                        # 2026-08-11: a schema with minItems:3 made every
                        # single request in a 436-item test batch fail
                        # identically at submission time before generating
                        # anything -- "minItems values other than 0 or 1 are
                        # not supported"). Exactly-3 is enforced downstream
                        # in cmd_poll's own shape check instead.
                        "distractors": {"type": "array", "items": {"type": "string"}},
                        "source_quote": {"type": "string"},
                    },
                    "required": ["question", "answer", "distractors", "source_quote"],
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
    # AC: pdf_text (real full document), NOT description -- the fix.
    # status='active' + a real length floor so a doc with a near-empty
    # pdf_text (scrape gap) doesn't burn a call for nothing.
    if only_types is None or "ac" in only_types:
        pools["ac"] = mgmt_sql("""
            select document_number as item_id, title, pdf_text as body_text
            from advisory_circulars
            where status = 'active' and pdf_text is not null and length(pdf_text) > 500
            order by document_number
        """)
    out = []
    for t in ["far", "aim", "ac"]:
        if t in pools:
            out += [(t, r) for r in pools[t]]
    return out


def make_custom_id(item_type, item_id, seq):
    return f"{item_type}_{seq}"


LABEL_PREFIX = {"far": "FAR §", "aim": "AIM", "ac": "AC"}


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
            # 3000 was the fix for author_fact_deck.py's identical
            # adaptive-thinking-eats-max_tokens bug at 700/1500 -- carried
            # forward here at 5000 since this schema's output is bigger
            # (up to 8 facts x (question+answer+3 distractors+quote) vs the
            # original's up to 3 facts x (question+answer+quote)).
            max_tokens=5000,
            system=SYSTEM_PROMPT,
            output_config={"effort": "medium", "format": FACT_FORMAT},
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
          f"source items ({len(sources)} total).")

    id_map = {}
    requests = []
    for seq, (t, r) in enumerate(sources):
        cid = make_custom_id(t, r["item_id"], seq)
        id_map[cid] = {"item_type": t, "item_id": r["item_id"]}
        requests.append(build_request(t, r, cid))
    json.dump(id_map, open(id_map_path, "w"))

    total_input_chars = sum(len((r["body_text"] or "")[:MAX_BODY_CHARS]) for _, r in sources)
    est_input_tokens = total_input_chars // 4 + len(sources) * 250
    # ~6 cards/item avg * ~300 tok/card (q+a+3 distractors+quote in JSON)
    est_output_tokens = len(sources) * 6 * 300
    est_cost = est_input_tokens / 1_000_000 * 1.0 + est_output_tokens / 1_000_000 * 5.0
    print(f"Estimated ~{est_input_tokens:,} input / ~{est_output_tokens:,} output tokens, "
          f"~${est_cost:.2f} (batch-rate, Sonnet 5 intro pricing).")

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status,
             "item_count": len(sources), "created_at": time.time()}
    json.dump(state, open(state_path, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")
    print(f"State saved to {state_path}. Run --poll (same --types) to check progress / ingest when done.")


def normalize_ws(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


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
        for fact in facts[:8]:
            q, a = fact.get("question", ""), fact.get("answer", "")
            distractors = fact.get("distractors", [])
            quote = fact.get("source_quote", "")
            if not (q.strip().endswith("?") and 8 <= len(q) <= 160 and 1 <= len(a) <= 110):
                rejected_shape += 1
                continue
            if not (isinstance(distractors, list) and len(distractors) == 3 and all(isinstance(d, str) and d.strip() for d in distractors)):
                rejected_shape += 1
                continue
            if normalize_ws(quote) not in src_body_norm:
                rejected_ungrounded += 1
                continue
            accepted += 1
            rows.append({
                "item_type": item_type, "item_id": item_id,
                "question": q.strip(), "answer": a.strip(),
                "distractors": [d.strip() for d in distractors],
                "source_quote": quote.strip(),
                "status": "pending", "model": AUTHOR_MODEL,
            })

    print(f"\nParsed {batch.request_counts.succeeded} responses: "
          f"{accepted} facts accepted, {empty} items had no extractable fact, "
          f"{rejected_shape} rejected (shape/length), {rejected_ungrounded} rejected (ungrounded quote), "
          f"{errored} request errors.")

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
    print("Authoring complete. Run --verify (Haiku) to grade and promote to status=live.")


VERIFY_SYSTEM = """You fact-check a flashcard (question, correct answer, AND 3 distractors) against its source regulatory text.

Given SOURCE_TEXT, a QUESTION, an ANSWER, and 3 DISTRACTORS, decide whether the card is sound.
Respond with JSON only:
{"verdict": "pass" | "fail", "corrected_answer": string or null}

"pass": the answer is accurate and grounded in the source text as written, AND all 3 distractors are
clearly wrong (none of them could also be defended as correct given the source text).
"fail": the answer is wrong/unsupported, OR any distractor is actually correct/ambiguous (which would
make the question have more than one right answer). If a small, precise correction to the ANSWER
alone would fix it, include it as corrected_answer; otherwise corrected_answer is null and the card
should be discarded (a bad distractor cannot be auto-corrected the way an answer can, since we don't
know what a better distractor should be -- discard rather than guess)."""

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
    # Only verify rows this script's own authoring pass produced (has
    # distractors set) -- never touch author_fact_deck.py's pending rows,
    # if any exist, since this is a different schema/contract.
    pending = rest_get_all(
        "/rest/v1/study_facts?status=eq.pending&distractors=not.is.null"
        "&select=id,item_type,item_id,question,answer,distractors,source_quote"
    )
    if not pending:
        print("No pending question-bank facts to verify.")
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
                   f"QUESTION: {row['question']}\nANSWER: {row['answer']}\n"
                   f"DISTRACTORS: {', '.join(row['distractors'])}")
        requests.append(Request(
            custom_id=row["id"],
            params=MessageCreateParamsNonStreaming(
                model=VERIFY_MODEL, max_tokens=1024, system=VERIFY_SYSTEM,
                output_config={"format": VERIFY_FORMAT},
                messages=[{"role": "user", "content": content}],
            ),
        ))

    batch = client.messages.batches.create(requests=requests)
    print(f"Verify batch submitted: {batch.id}.")
    json.dump({"verify_batch_id": batch.id, "count": len(pending)},
               open(os.path.join(BASE, "scripts", ".question_bank_verify_state.json"), "w"), indent=2)


def cmd_verify_poll():
    vstate_path = os.path.join(BASE, "scripts", ".question_bank_verify_state.json")
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

    # Resume-safe: a prior run may have crashed/hung partway through (this
    # loop makes one blocking network PATCH per result, and this batch has
    # 16k+ results -- a transient SSL/network stall is a real, observed
    # failure mode, not hypothetical). Every write below is a deterministic
    # PATCH keyed by the batch's own immutable custom_id, so skipping ids
    # that are no longer 'pending' is always safe (idempotent by
    # construction) and turns a restart from "redo everything" into "pick
    # up where it left off" -- fetched fresh, not trusted from a stale
    # in-memory set.
    still_pending = set(r["id"] for r in rest_get_all(
        "/rest/v1/study_facts?status=eq.pending&select=id"))
    print(f"{len(still_pending)} facts still pending -- resuming from there.")

    passed, corrected, failed, skipped, already_done, n = 0, 0, 0, 0, 0, 0
    for result in client.messages.batches.results(batch.id):
        n += 1
        if n % 1000 == 0:
            print(f"  ...{n} results scanned ({passed + corrected + failed} written this run)")
        fact_id = result.custom_id
        if fact_id not in still_pending:
            already_done += 1
            continue
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
            skipped += 1
            continue
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
          f"verdict -- re-run --verify to retry these), {already_done} already done "
          f"from a prior run (skipped, not re-written).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--verify-poll", action="store_true")
    ap.add_argument("--types", default="far,aim,ac", help="comma-separated subset of far,aim,ac")
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
