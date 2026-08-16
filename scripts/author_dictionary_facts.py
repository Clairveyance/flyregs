#!/usr/bin/env python3
"""Author Aviation Dictionary study_facts via the Anthropic Batches API.

Forked from author_question_bank.py (same proven safety mechanisms:
double-submit guard, batch state files, grounding verification, separate
verify pass) rather than editing that file in place -- same reasoning as
that file's own fork-not-edit-in-place comment: it's the live pipeline
behind 20,000+ already-verified facts and shouldn't be risked.

Two pools, two different treatments (RC 2026-08-16 scoping):
1. handbook (5,292 items): definitional/scenario Q&A + 3 LLM-authored
   distractors, same contract shape as FAR/AIM/AC but capped at 1-2 facts
   (not 4-8) since dictionary definitions are short (~137 chars avg vs a
   full section/document) and can't honestly support 4-8 DISTINCT facts.
2. mnemonic (48 items): ONE scenario-recall fact per mnemonic ("which
   mnemonic covers a missed approach?" -> the mnemonic itself), NO LLM
   distractors -- any other real mnemonic term is an inherently plausible
   wrong answer here (unlike a numeric FAR threshold, there's no
   domain-nuance a wrong pick could violate), so distractors are filled
   deterministically at ingest from other quizzable mnemonic terms. Cheaper
   and equally reliable.

NOTE: the free, zero-cost mnemonic LETTER-recall pass ("what does the C in
COMBATS stand for") is a SEPARATE script (build_mnemonic_letter_facts.py)
-- pure template pull from already-curated breakdown data, no LLM
involved. This script's mnemonic pool is deliberately the scenario-recall
question only, using senses[0].definition, NOT breakdown.

Priced 2026-08-16 (see PROJECT_NOTES/flyregs_pending.md): ~$10 authoring +
~$2.50 verify, Sonnet 5 batch rate, intro pricing through 2026-08-31.

SAFETY: never run --submit twice concurrently -- see
memory/gotcha_double_background_process.md. Refuses to resubmit if a
non-terminal batch state file already exists.

Usage:
  python3 scripts/author_dictionary_facts.py --submit --types=handbook,mnemonic
  python3 scripts/author_dictionary_facts.py --poll --types=handbook,mnemonic
  python3 scripts/author_dictionary_facts.py --verify
  python3 scripts/author_dictionary_facts.py --verify-poll
"""
import argparse, json, os, random, re, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".dictionary_facts_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".dictionary_facts_id_map.json")
AUTHOR_MODEL = "claude-sonnet-5"
VERIFY_MODEL = "claude-haiku-4-5-20251001"  # matches author_question_bank.py's current verify model
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


def rest_get_all(path):
    """PostgREST caps unfiltered .select() at 1000 rows -- page with Range."""
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


HANDBOOK_SYSTEM = """You write fact-recall flashcards AND their multiple-choice distractors from FAA Aviation Dictionary definitions (Pilot's Handbook of Aeronautical Knowledge terminology), for a pilot study/duel app.

CONTRACT (do not deviate):
- Question: ONE short sentence or phrase, ending in "?", under 140 characters. It asks about a CONCRETE fact or distinction stated in the text -- a definition, a distinguishing condition, or a named relationship. Never a vague "what does this term mean?" framing.
- Answer: a short factual PHRASE, not a full sentence. Under 90 characters.
- distractors: exactly 3 plausible-but-WRONG answers in the SAME shape/format as the real answer. A distractor must be clearly, unambiguously wrong to someone who actually knows the term -- never a second technically-correct phrasing of the same right answer, never something so implausible it gives itself away.
- source_quote: copy the EXACT contiguous span of the provided BODY_TEXT (character-for-character, no paraphrasing) that supports your answer. This is used to programmatically verify you didn't invent the fact.

STYLE STEER: favor SCENARIO-TO-TERM framing over bare definitional recall whenever the passage supports it -- frame the question around a concrete operational condition or situation, and make the answer the specific term or distinction that applies.

Real examples of the target shape:
Q: "What is the term for the imaginary point ahead of an aircraft where two intersecting radials would cross?"
A: "fix"
Q: "What condition causes an aircraft's true airspeed to exceed its indicated airspeed at altitude?"
A: "lower air density"

Return 1 to 2 DISTINCT facts -- most short definitions support exactly one; a definition with a genuinely separate second distinction may support two. Never invent a fact or near-duplicate just to hit a count. If the passage has NO clean extractable fact, return an EMPTY facts array.

Respond with JSON only, matching the schema."""

HANDBOOK_FORMAT = {
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

MNEMONIC_SYSTEM = """You write ONE scenario-recall flashcard from an aviation memory-aid mnemonic's meaning, for a pilot study/duel app.

CONTRACT (do not deviate):
- Question: ONE sentence describing the operational SITUATION or PURPOSE the mnemonic is used for (never the mnemonic's own letters -- those are tested separately). Under 140 characters.
- Answer: the mnemonic itself (the acronym/phrase), under 40 characters, EXACTLY as given in the label.
- source_quote: copy the EXACT contiguous span of the provided BODY_TEXT that supports your answer.

Return exactly 1 fact. Respond with JSON only, matching the schema."""

MNEMONIC_FORMAT = {
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


def fetch_sources(only_types):
    pools = {}
    if "handbook" in only_types:
        pools["handbook"] = mgmt_sql("""
            select slug as item_id, term as title, quiz_prompt as body_text
            from quizzable_dictionary_terms
            where category = 'handbook'
              and slug not in (select item_id from study_facts where item_type = 'dictionary' and status in ('live', 'pending'))
            order by slug
        """)
    if "mnemonic" in only_types:
        pools["mnemonic"] = mgmt_sql("""
            select slug as item_id, term as title, quiz_prompt as body_text
            from quizzable_dictionary_terms
            where category = 'mnemonic'
              and slug not in (select item_id from study_facts where item_type = 'dictionary' and status in ('live', 'pending'))
            order by slug
        """)
    out = []
    for t in ["handbook", "mnemonic"]:
        if t in pools:
            out += [(t, r) for r in pools[t]]
    return out


def make_custom_id(pool_type, seq):
    return f"{pool_type}_{seq}"


LABEL_PREFIX = {"handbook": "AVIATION DICTIONARY", "mnemonic": "MNEMONIC"}


def build_request(pool_type, row, custom_id):
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    body = (row["body_text"] or "")[:MAX_BODY_CHARS]
    label = f"{LABEL_PREFIX[pool_type]} — {row['title']}"
    user_content = f"{label}\n\nBODY_TEXT:\n{body}"
    system = HANDBOOK_SYSTEM if pool_type == "handbook" else MNEMONIC_SYSTEM
    fmt = HANDBOOK_FORMAT if pool_type == "handbook" else MNEMONIC_FORMAT
    return Request(
        custom_id=custom_id,
        params=MessageCreateParamsNonStreaming(
            model=AUTHOR_MODEL,
            # Same adaptive-thinking-eats-max_tokens headroom as
            # author_fact_deck.py / author_question_bank.py's own fix.
            max_tokens=3000,
            system=system,
            output_config={"effort": "medium", "format": fmt},
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
    counts = {t: sum(1 for tt, _ in sources if tt == t) for t in ["handbook", "mnemonic"]}
    print(f"Fetched {counts.get('handbook', 0)} handbook + {counts.get('mnemonic', 0)} mnemonic "
          f"source items ({len(sources)} total).")
    if not sources:
        print("Nothing to submit.")
        return

    id_map = {}
    sources_snapshot = {}
    requests = []
    for seq, (t, r) in enumerate(sources):
        cid = make_custom_id(t, seq)
        id_map[cid] = {"pool_type": t, "item_id": r["item_id"], "title": r["title"]}
        sources_snapshot[f"{t}:{r['item_id']}"] = r["body_text"]
        requests.append(build_request(t, r, cid))
    json.dump(id_map, open(id_map_path, "w"))
    json.dump(sources_snapshot, open(id_map_path.replace("id_map", "sources_snapshot"), "w"))

    handbook_chars = sum(len((r["body_text"] or "")[:MAX_BODY_CHARS]) for t, r in sources if t == "handbook")
    mnemonic_chars = sum(len((r["body_text"] or "")[:MAX_BODY_CHARS]) for t, r in sources if t == "mnemonic")
    # Calibrated 2026-08-16 via real count_tokens() against these exact
    # prompts (see PROJECT_NOTES/flyregs_pending.md) -- not a blind chars/4
    # guess: handbook system ~585 tok fixed + ~2.6 chars/tok marginal;
    # mnemonic system ~265 tok fixed (no distractor contract) + ~2.4 chars/tok.
    est_input_tokens = (
        counts.get("handbook", 0) * 585 + int(handbook_chars / 2.6)
        + counts.get("mnemonic", 0) * 265 + int(mnemonic_chars / 2.4)
    )
    est_output_tokens = counts.get("handbook", 0) * 250 + counts.get("mnemonic", 0) * 150
    est_cost = est_input_tokens / 1_000_000 * 1.0 + est_output_tokens / 1_000_000 * 5.0
    print(f"Estimated ~{est_input_tokens:,} input / ~{est_output_tokens:,} output tokens, "
          f"~${est_cost:.2f} (batch-rate, Sonnet 5 intro pricing through 2026-08-31).")

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
    sources_snapshot = json.load(open(id_map_path.replace("id_map", "sources_snapshot")))

    # For deterministic mnemonic-scenario distractors: pull every quizzable
    # mnemonic term now, so a wrong answer is always a REAL other mnemonic.
    mnemonic_terms = [r["term"] for r in mgmt_sql(
        "select term from quizzable_dictionary_terms where category = 'mnemonic'")]

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
        pool_type, item_id, title = mapped["pool_type"], mapped["item_id"], mapped["title"]
        src_body_norm = normalize_ws(sources_snapshot.get(f"{pool_type}:{item_id}"))
        max_facts = 2 if pool_type == "handbook" else 1
        for fact in facts[:max_facts]:
            q, a = fact.get("question", ""), fact.get("answer", "")
            quote = fact.get("source_quote", "")
            if not (q.strip().endswith("?") and 8 <= len(q) <= 160 and 1 <= len(a) <= 110):
                rejected_shape += 1
                continue
            if normalize_ws(quote) not in src_body_norm:
                rejected_ungrounded += 1
                continue

            if pool_type == "handbook":
                distractors = fact.get("distractors", [])
                if not (isinstance(distractors, list) and len(distractors) == 3
                        and all(isinstance(d, str) and d.strip() for d in distractors)):
                    rejected_shape += 1
                    continue
                distractors = [d.strip() for d in distractors]
            else:
                # Deterministic: 3 other real mnemonic terms, excluding this one.
                candidates = [t for t in mnemonic_terms if t != a.strip()]
                random.shuffle(candidates)
                distractors = candidates[:3]
                if len(distractors) < 3:
                    rejected_shape += 1
                    continue

            accepted += 1
            rows.append({
                "item_type": "dictionary", "item_id": item_id,
                "question": q.strip(), "answer": a.strip(), "source_quote": quote.strip()[:500],
                "distractors": distractors,
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
    print("Authoring complete. Run --verify to grade and promote to status=live.")


VERIFY_SYSTEM = """You fact-check a flashcard against its source text.

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

VERIFY_STATE_PATH = os.path.join(BASE, "scripts", ".dictionary_facts_verify_batch_state.json")
VERIFY_ID_MAP_PATH = os.path.join(BASE, "scripts", ".dictionary_facts_verify_id_map.json")


def cmd_verify():
    if os.path.exists(VERIFY_STATE_PATH):
        state = json.load(open(VERIFY_STATE_PATH))
        if state.get("status") != "ended":
            print(f"Refusing to resubmit -- verify batch {state['batch_id']} already exists "
                  f"(status last seen: {state.get('status')}). Run --verify-poll instead.")
            sys.exit(1)

    pending = [r for r in rest_get_all("/rest/v1/study_facts?item_type=eq.dictionary&status=eq.pending&select=*")]
    print(f"Verifying {len(pending)} pending dictionary facts on {VERIFY_MODEL}...")
    if not pending:
        print("Nothing to verify.")
        return

    # fetch_sources() excludes already-live/pending items, which these now
    # are -- pull raw source text directly instead.
    ids = list({r["item_id"] for r in pending})
    raw = mgmt_sql(f"""
        select slug as item_id, quiz_prompt as body_text
        from quizzable_dictionary_terms
        where slug in ({','.join("'" + i.replace("'", "''") + "'" for i in ids)})
    """)
    sources = {r["item_id"]: r["body_text"] for r in raw}

    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    id_map, requests = {}, []
    for seq, r in enumerate(pending):
        cid = f"v_{seq}"
        id_map[cid] = r["id"]
        src = sources.get(r["item_id"], "")[:MAX_BODY_CHARS]
        user_content = f"SOURCE_TEXT:\n{src}\n\nQUESTION: {r['question']}\nANSWER: {r['answer']}"
        requests.append(Request(
            custom_id=cid,
            params=MessageCreateParamsNonStreaming(
                model=VERIFY_MODEL, max_tokens=1024, system=VERIFY_SYSTEM,
                output_config={"format": VERIFY_FORMAT},
                messages=[{"role": "user", "content": user_content}],
            ),
        ))
    json.dump(id_map, open(VERIFY_ID_MAP_PATH, "w"))

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status, "created_at": time.time()}
    json.dump(state, open(VERIFY_STATE_PATH, "w"), indent=2)
    print(f"Verify batch submitted: {batch.id}. Run --verify-poll once done.")


def cmd_verify_poll():
    if not os.path.exists(VERIFY_STATE_PATH):
        print("No verify batch state found -- run --verify first.")
        sys.exit(1)
    state = json.load(open(VERIFY_STATE_PATH))
    id_map = json.load(open(VERIFY_ID_MAP_PATH))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Verify batch {batch.id}: {batch.processing_status} "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored})")
    state["status"] = batch.processing_status
    json.dump(state, open(VERIFY_STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet.")
        return

    passed, failed, corrected, discarded, errored = 0, 0, 0, 0, 0
    total_in_tok, total_out_tok = 0, 0
    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            errored += 1
            continue
        fact_id = id_map.get(result.custom_id)
        if not fact_id:
            continue
        msg = result.result.message
        total_in_tok += msg.usage.input_tokens
        total_out_tok += msg.usage.output_tokens
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            errored += 1
            continue
        verdict = parsed.get("verdict")
        corrected_answer = parsed.get("corrected_answer")
        if verdict == "pass":
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "live", "verified_at": "now()", "verified_model": VERIFY_MODEL})
            passed += 1
        elif corrected_answer:
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "live", "answer": corrected_answer,
                       "verified_at": "now()", "verified_model": VERIFY_MODEL})
            corrected += 1
        else:
            rest("PATCH", f"/rest/v1/study_facts?id=eq.{fact_id}",
                 body={"status": "flagged", "verified_at": "now()", "verified_model": VERIFY_MODEL})
            failed += 1
            discarded += 1

    cost = total_in_tok / 1_000_000 * 0.5 + total_out_tok / 1_000_000 * 2.5  # Haiku batch rate
    print(f"Verified: {passed} passed, {corrected} corrected+passed, {discarded} flagged/discarded, "
          f"{errored} errors. Cost: ~${cost:.2f} at Haiku batch rate.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--verify-poll", action="store_true")
    ap.add_argument("--types", default="handbook,mnemonic")
    args = ap.parse_args()

    only_types = args.types.split(",")

    if args.submit:
        cmd_submit(only_types)
    elif args.poll:
        cmd_poll(only_types)
    elif args.verify:
        cmd_verify()
    elif args.verify_poll:
        cmd_verify_poll()
    else:
        print(__doc__)
