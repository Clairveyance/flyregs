#!/usr/bin/env python3
"""Re-author (repair) the study_facts rows that the verify pass rejected AND
that triage judged genuinely salvageable -- on Opus 5, via the Batches API.

RC approved 2026-08-12 after a two-stage cost-reduction pass:
  stage 1  scripts/triage_flagged_facts.py (Haiku, $0.87 real) classified all
           1,223 status='flagged' rows into fixable / weak_source / borderline.
  stage 2  this script re-authors ONLY the 473 'fixable' ones on Opus.
The 745 'weak_source' rows are deliberately NOT re-authored: triage judged
their stored source_quote genuinely can't support a clean question (e.g. an
isolated list item "(9) Operations control specialist duties." used to claim
"9 total functions"), which no amount of model strength fixes.

WHY REPAIR-IN-PLACE, NOT RE-AUTHOR-FROM-SCRATCH
------------------------------------------------
The original authoring pass (author_question_bank.py) generates 4-8 NEW facts
per source item. Running that again on these items would produce duplicates of
the already-live facts from those same items. Instead this sends Opus the
source text AND the specific failed fact(s), and asks for a corrected version
of each -- so one flagged row in, one repaired row out, updated in place by id.

Grouped one request per SOURCE ITEM, not per fact: 473 facts span only 431
distinct items, and the body text (which dominates input tokens) would
otherwise be re-sent for each fact of a shared item.

SAME QUALITY BAR AS THE ORIGINAL -- repaired facts do NOT go straight live:
they're written back at status='pending' with verified_at/verified_model
cleared, so the existing --verify pass (author_question_bank.py --verify)
grades them exactly like any freshly-authored fact. A repair that's still bad
gets flagged again rather than quietly shipping.

Usage:
  python3 scripts/repair_flagged_facts.py --submit
  python3 scripts/repair_flagged_facts.py --poll
  # then, to grade the repairs through the normal pipeline:
  python3 scripts/author_question_bank.py --verify
  python3 scripts/author_question_bank.py --verify-poll
"""
import argparse, json, os, re, sys, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRIAGE_PATH = os.path.join(BASE, "scripts", "flagged_triage_results.json")
STATE_PATH = os.path.join(BASE, "scripts", ".repair_flagged_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".repair_flagged_id_map.json")
REPAIR_MODEL = "claude-opus-5"
MAX_BODY_CHARS = 8000

# Opus 5 Batches API rate (50% of standard $5/$25 per MTok), confirmed
# against platform.claude.com/docs pricing 2026-08-12.
OPUS_BATCH_IN_PER_MTOK = 2.50
OPUS_BATCH_OUT_PER_MTOK = 12.50


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


def normalize_ws(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


SYSTEM_PROMPT = """You REPAIR rejected fact-recall flashcards for an FAA regulatory study/duel app.

Each input gives you the source BODY_TEXT plus one or more REJECTED facts that were auto-authored from it and failed a quality check. Typical defects: missing or absent distractors, awkward/ambiguous question phrasing, an answer that restates the question, a question needing context it doesn't give, or a source_quote that doesn't cleanly support the claim.

For each rejected fact, return a REPAIRED version obeying this contract exactly:
- question: ONE short sentence or phrase ending in "?", under 140 characters, asking about a CONCRETE fact stated in BODY_TEXT -- a number, limit, distance, altitude, time period, threshold, or named requirement. Never a vague "what does this section require?" framing. It must stand on its own: a reader who cannot see the regulation must still know what is being asked.
- answer: a short factual PHRASE, not a full sentence. Under 90 characters.
- distractors: exactly 3 plausible-but-WRONG answers in the SAME shape/format/units as the real answer (if the answer is a distance in feet, distractors are other plausible distances in feet). Each must be unambiguously wrong to someone who knows the source -- never a second correct phrasing of the same answer, never so silly it gives itself away.
- source_quote: copy the EXACT contiguous span of the provided BODY_TEXT (character-for-character, no paraphrasing, no ellipsis) that supports your answer. This is verified programmatically; a paraphrase is rejected.

You may keep the original fact's subject but you are NOT bound to its wording, its answer framing, or its original quote -- pick the best supported version of that fact from BODY_TEXT. Prefer FAA-style scenario-to-threshold framing (a concrete operational situation, answered by the specific number/procedure/threshold) over citation-cross-reference or administrative trivia.

If a rejected fact genuinely CANNOT be repaired into a clean, well-grounded question from BODY_TEXT, omit it from your response entirely rather than inventing support for it. Returning fewer repairs than you were given is correct and expected in that case.

Return each repair with the "index" of the rejected fact it corresponds to. Respond with JSON only, matching the schema."""

REPAIR_FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "repairs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer"},
                        "question": {"type": "string"},
                        "answer": {"type": "string"},
                        # minItems > 1 is unsupported by the structured-output
                        # validator (see author_question_bank.py's own note --
                        # a minItems:3 schema failed all 436 requests in a test
                        # batch at submission). Exactly-3 enforced in --poll.
                        "distractors": {"type": "array", "items": {"type": "string"}},
                        "source_quote": {"type": "string"},
                    },
                    "required": ["index", "question", "answer", "distractors", "source_quote"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["repairs"],
        "additionalProperties": False,
    },
}

LABEL_PREFIX = {"far": "FAR §", "aim": "AIM", "ac": "AC"}


def fetch_fixable_facts():
    """The 473 triage-approved rows, joined to their source body text."""
    triage = json.load(open(TRIAGE_PATH))
    fixable_ids = [r["id"] for r in triage if r["verdict"] == "fixable"]
    if not fixable_ids:
        raise RuntimeError("No 'fixable' ids in triage results -- run triage_flagged_facts.py first.")
    inlist = ",".join("'" + i + "'" for i in fixable_ids)
    rows = mgmt_sql(f"""
        select sf.id, sf.item_type, sf.item_id, sf.question, sf.answer,
               sf.distractors, sf.source_quote,
               coalesce(f.title, a.title, c.title) as title,
               coalesce(f.body_text, a.body_text, c.pdf_text) as body_text
        from study_facts sf
        left join far_sections f on sf.item_type = 'far' and f.section_number = sf.item_id
        left join aim_paragraphs a on sf.item_type = 'aim' and a.paragraph_number = sf.item_id
        left join advisory_circulars c on sf.item_type = 'ac' and c.document_number = sf.item_id
        where sf.id in ({inlist})
          and sf.status = 'flagged'
        order by sf.item_type, sf.item_id
    """)
    return rows


def group_by_item(rows):
    groups = {}
    for r in rows:
        if not r.get("body_text"):
            continue  # no source to repair against; skipped and reported
        groups.setdefault((r["item_type"], r["item_id"]), []).append(r)
    return groups


def cmd_submit():
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
        print(f"A repair batch already exists: {state['batch_id']} (status={state.get('status')}).\n"
              f"Refusing to double-submit -- run --poll, or delete {STATE_PATH} if that batch is truly finished with.")
        sys.exit(1)

    rows = fetch_fixable_facts()
    groups = group_by_item(rows)
    skipped_no_body = len(rows) - sum(len(v) for v in groups.values())
    print(f"{len(rows)} fixable facts across {len(groups)} source items "
          f"({skipped_no_body} skipped: no source body text).")

    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    requests_out, id_map = [], {}
    for seq, ((item_type, item_id), facts) in enumerate(sorted(groups.items())):
        body = (facts[0]["body_text"] or "")[:MAX_BODY_CHARS]
        label = f"{LABEL_PREFIX[item_type]} {item_id}"
        listing = []
        for i, f in enumerate(facts):
            listing.append(
                f"[{i}] QUESTION: {f['question']}\n"
                f"    ANSWER: {f['answer']}\n"
                f"    DISTRACTORS: {f['distractors'] if f['distractors'] else '(none were produced)'}\n"
                f"    SOURCE_QUOTE: {f['source_quote']}"
            )
        user_content = (
            f"{label} — {facts[0].get('title') or ''}\n\n"
            f"BODY_TEXT:\n{body}\n\n"
            f"REJECTED FACTS TO REPAIR ({len(facts)}):\n" + "\n\n".join(listing)
        )
        custom_id = f"repair_{seq}"
        id_map[custom_id] = {
            "item_type": item_type, "item_id": item_id,
            "fact_ids": [f["id"] for f in facts],
        }
        requests_out.append(Request(
            custom_id=custom_id,
            params=MessageCreateParamsNonStreaming(
                model=REPAIR_MODEL,
                # Generous ceiling: only real output tokens are billed, and a
                # too-tight max_tokens is a known failure mode here (adaptive
                # thinking can consume the budget before any content lands --
                # see memory/gotcha_sonnet5_thinking_max_tokens.md).
                max_tokens=4000,
                system=SYSTEM_PROMPT,
                output_config={"format": REPAIR_FORMAT},
                messages=[{"role": "user", "content": user_content}],
            ),
        ))

    batch = client.messages.batches.create(requests=requests_out)
    json.dump({"batch_id": batch.id, "status": batch.processing_status,
               "item_count": len(requests_out), "fact_count": sum(len(v) for v in groups.values())},
              open(STATE_PATH, "w"), indent=2)
    json.dump(id_map, open(ID_MAP_PATH, "w"), indent=2)
    print(f"Submitted repair batch {batch.id} on {REPAIR_MODEL}: "
          f"{len(requests_out)} requests covering {sum(len(v) for v in groups.values())} facts.")
    print("Run --poll to ingest once it ends.")


def cmd_poll():
    if not os.path.exists(STATE_PATH):
        print("No repair batch in progress -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])
    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Repair batch {batch.id}: {batch.processing_status} "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored} "
          f"processing={batch.request_counts.processing})")
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet. Re-run --poll later.")
        return

    id_map = json.load(open(ID_MAP_PATH))
    # Re-fetch source bodies for the grounding check -- never trust the
    # model's quote without confirming it appears verbatim in the real source.
    src_rows = fetch_fixable_facts()
    bodies, originals = {}, {}
    for r in src_rows:
        bodies[(r["item_type"], r["item_id"])] = normalize_ws(r.get("body_text"))
        originals[r["id"]] = r

    repaired, rejected_shape, rejected_ungrounded, omitted, errored = 0, 0, 0, 0, 0
    total_in_tok, total_out_tok = 0, 0
    updates = []
    seen_fact_ids = set()

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
        mapped = id_map.get(result.custom_id)
        if not mapped:
            rejected_shape += 1
            continue
        item_type, item_id = mapped["item_type"], mapped["item_id"]
        fact_ids = mapped["fact_ids"]
        src_body = bodies.get((item_type, item_id), "")

        for rep in parsed.get("repairs", []):
            idx = rep.get("index")
            if not isinstance(idx, int) or not (0 <= idx < len(fact_ids)):
                rejected_shape += 1
                continue
            fact_id = fact_ids[idx]
            if fact_id in seen_fact_ids:
                rejected_shape += 1  # duplicate index in one response
                continue
            q, a = rep.get("question", ""), rep.get("answer", "")
            distractors = rep.get("distractors", [])
            quote = rep.get("source_quote", "")
            if not (q.strip().endswith("?") and 8 <= len(q) <= 160 and 1 <= len(a) <= 110):
                rejected_shape += 1
                continue
            if not (isinstance(distractors, list) and len(distractors) == 3
                    and all(isinstance(d, str) and d.strip() for d in distractors)):
                rejected_shape += 1
                continue
            if normalize_ws(quote) not in src_body:
                rejected_ungrounded += 1
                continue
            seen_fact_ids.add(fact_id)
            updates.append({
                "id": fact_id,
                "question": q.strip(), "answer": a.strip(),
                "distractors": [d.strip() for d in distractors],
                "source_quote": quote.strip(),
            })
            repaired += 1

    all_fact_ids = {fid for m in id_map.values() for fid in m["fact_ids"]}
    omitted = len(all_fact_ids - seen_fact_ids)

    cost = (total_in_tok / 1_000_000 * OPUS_BATCH_IN_PER_MTOK
            + total_out_tok / 1_000_000 * OPUS_BATCH_OUT_PER_MTOK)
    print(f"\n{repaired} facts repaired, {rejected_shape} rejected (shape/length), "
          f"{rejected_ungrounded} rejected (ungrounded quote), "
          f"{omitted} left unrepaired (model declined or dropped), {errored} request errors.")
    print(f"Actual usage: {total_in_tok:,} input / {total_out_tok:,} output tokens "
          f"-> ${cost:.2f} at {REPAIR_MODEL} batch rate.")

    if not updates:
        print("Nothing to write.")
        return

    # One PATCH per row: the repaired question can collide with an existing
    # live fact for the same item under the (item_type,item_id,question)
    # unique constraint -- that's a real, expected outcome (the repair
    # converged on a question already authored), and must be counted and
    # skipped, never allowed to abort the rest of the write.
    written, conflicts, failed = 0, 0, 0
    for u in updates:
        fid = u.pop("id")
        u.update({"status": "pending", "verified_at": None,
                  "verified_model": None, "model": REPAIR_MODEL})
        status, body = rest("PATCH", f"/rest/v1/study_facts?id=eq.{fid}",
                            body=u, prefer="return=minimal")
        if status == 409:
            conflicts += 1
        elif status >= 300:
            failed += 1
            if failed <= 5:
                print(f"  PATCH {fid}: HTTP {status}: {str(body)[:200]}")
        else:
            written += 1

    print(f"\nWrote {written} repaired facts back at status='pending' "
          f"({conflicts} skipped: repaired question collided with an existing fact "
          f"for the same item, {failed} write failures).")
    print("Repairs are NOT live yet -- run:\n"
          "  python3 scripts/author_question_bank.py --verify\n"
          "  python3 scripts/author_question_bank.py --verify-poll")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    args = ap.parse_args()
    if args.submit:
        cmd_submit()
    elif args.poll:
        cmd_poll()
    else:
        ap.print_help()
