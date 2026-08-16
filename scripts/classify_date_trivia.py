#!/usr/bin/env python3
"""One-time classification pass: judge every live study_facts row whose
answer is a bare calendar date as genuinely useful (a real regulatory
compliance deadline/applicability cutoff) or paperwork trivia (when a
document/AC/amendment/act was itself issued, signed, published, or
superseded).

Real finding (RC, 2026-08-16, live Study Mode screenshot): "On what date
were the windshear training amendments to parts 121 and 135 issued? ->
September 27, 1988" -- a real, live example of exactly this failure mode.
author_question_bank.py's existing "NEVER ask about the document's own
paperwork" ban + METADATA_TRIVIA_RE backstop only catch questions about
the CURRENT document's own metadata; they miss questions about a
DIFFERENT document/act/amendment's date mentioned in the body text, which
this exact question is. 747 live facts corpus-wide match this shape (322
ac, 420 far, 5 aim) -- a keyword-only split couldn't reliably separate
genuine deadlines from trivia (only 233/747 cleanly matched "must/shall"
language), hence this LLM classification pass.

Cheap: Haiku 4.5 via Batches API, ~$0.09-0.25 (priced via count_tokens,
not run yet as of writing).

Usage:
  python3 scripts/classify_date_trivia.py --submit
  python3 scripts/classify_date_trivia.py --poll
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".date_trivia_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".date_trivia_id_map.json")
MODEL = "claude-haiku-4-5"


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


DATE_RE = re.compile(
    r"^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+(19|20)\d{2}",
    re.I)

SYSTEM = """You judge whether a study flashcard's DATE-based answer represents genuinely useful aviation knowledge or low-value document paperwork trivia.

KEEP ("useful"): the date is a real regulatory compliance deadline, applicability cutoff, or certification-relevant date that a pilot/mechanic/operator would plausibly need to track or know.
DISCARD ("trivia"): the date is about when a document/AC/amendment/act/rule was itself issued, signed, published, superseded, or dated -- administrative paperwork history, not operational knowledge. This includes dates of a DIFFERENT/referenced document mentioned within the source, not just the current one.

Respond with JSON only: {"verdict": "useful" | "trivia"}"""

FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {"verdict": {"type": "string", "enum": ["useful", "trivia"]}},
        "required": ["verdict"],
        "additionalProperties": False,
    },
}


def fetch_targets():
    rows = mgmt_sql("select id, item_type, item_id, question, answer from study_facts where status='live'")
    return [r for r in rows if DATE_RE.match(r["answer"] or "")]


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
    print(f"Found {len(targets)} live facts with a bare-date answer.")
    if not targets:
        print("Nothing to classify.")
        return

    id_map, requests = {}, []
    for seq, r in enumerate(targets):
        cid = f"dt_{seq}"
        id_map[cid] = r["id"]
        user_content = f"QUESTION: {r['question']}\nANSWER: {r['answer']}"
        requests.append(Request(
            custom_id=cid,
            params=MessageCreateParamsNonStreaming(
                model=MODEL, max_tokens=256, system=SYSTEM,
                output_config={"format": FORMAT},
                messages=[{"role": "user", "content": user_content}],
            ),
        ))
    json.dump(id_map, open(ID_MAP_PATH, "w"))

    batch = client.messages.batches.create(requests=requests)
    state = {"batch_id": batch.id, "status": batch.processing_status, "created_at": time.time()}
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")


def cmd_poll():
    if not os.path.exists(STATE_PATH):
        print("No batch state found -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))
    id_map = json.load(open(ID_MAP_PATH))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Batch {batch.id}: {batch.processing_status} "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored})")
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet.")
        return

    useful, trivia, errored = 0, [], 0
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
            verdict = json.loads(text).get("verdict")
        except json.JSONDecodeError:
            errored += 1
            continue
        if verdict == "useful":
            useful += 1
        elif verdict == "trivia":
            trivia.append(fact_id)
        else:
            errored += 1

    cost = total_in_tok / 1_000_000 * 0.5 + total_out_tok / 1_000_000 * 2.5  # Haiku batch rate
    print(f"\n{useful} useful, {len(trivia)} trivia, {errored} errors. "
          f"Actual usage: {total_in_tok:,} in / {total_out_tok:,} out -> ~${cost:.3f}")

    if not trivia:
        print("Nothing to flag.")
        return

    flagged = 0
    for i in range(0, len(trivia), 200):
        chunk = trivia[i:i + 200]
        id_list = ",".join(chunk)
        status, body = rest("PATCH", f"/rest/v1/study_facts?id=in.({id_list})",
                             body={"status": "flagged", "verified_model": "manual-date-trivia-classify-2026-08-16"})
        if status >= 300:
            print(f"  PATCH chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            flagged += len(chunk)
    print(f"Flagged {flagged} trivia rows out of live.")


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
        print(__doc__)
