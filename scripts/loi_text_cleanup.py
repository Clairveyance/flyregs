#!/usr/bin/env python3
"""LOI mild/moderate-tier OCR text repair -- text-only LLM reconstruction,
no Vision/image tokens. Second half of the RC-approved tiered cost plan
(PROJECT_NOTES/flyregs_pending.md, 2026-08-19: "severe tier -> Vision,
everything else -> cheap text-only cleanup, ~$3-5 total for both tiers" --
greenlit 2026-08-22).

Targets ocr_quality_score in [3.0, 6.0) -- the >=6.0 "severe" tier goes
through sync/loi_vision_cleanup.py instead (image re-transcription; a
character-substitution/spurious-space garble this bad usually means the
text layer itself is too degraded to safely reconstruct from context
alone). Below 3.0 needs nothing. Score is loi_quality_scan.py's own
composite (dictionary-miss ratio + spurious mid-word-space rate + junk
symbol runs); re-run `python3 scripts/loi_quality_scan.py --backfill`
after this to get accurate post-cleanup scores (does not auto-refresh).

SAFETY: this rewrites the actual legal text of an FAA regulatory
interpretation. Per this project's own "Data Is King" / "never fabricate
content" rules, the model is instructed to reconstruct OCR corruption
only -- fix spurious spacing and character-substitution errors, restore
words, never paraphrase, never add/remove/reorder content, never resolve
an ambiguity the model can't actually read. Two independent, non-LLM
grounding checks run on every result before it's ever written:
  1. length ratio (chars) must stay in [0.90, 1.10] of the original --
     real OCR repair only ever collapses spurious spaces and swaps
     characters, so length barely moves; a bigger swing means the model
     paraphrased or dropped/added content.
  2. every digit-run of 2+ digits in the original (section numbers, dates,
     citations -- the exact things that must never silently change in a
     regulatory document) must appear, character-for-character, somewhere
     in the cleaned text.
A result that fails either check is left untouched and reported, never
force-written.

Usage:
  python3 scripts/loi_text_cleanup.py --submit --limit 5   # small validation batch first
  python3 scripts/loi_text_cleanup.py --poll --limit 5
  python3 scripts/loi_text_cleanup.py --submit             # full mild/moderate tier
  python3 scripts/loi_text_cleanup.py --poll
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE, "scripts", ".loi_text_cleanup_batch_state.json")
ID_MAP_PATH = os.path.join(BASE, "scripts", ".loi_text_cleanup_id_map.json")
SNAPSHOT_PATH = os.path.join(BASE, "scripts", ".loi_text_cleanup_sources_snapshot.json")
MODEL = "claude-haiku-4-5-20251001"


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


def rest(method, path, *, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SUPABASE_URL + path, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    if data:
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", "return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


SYSTEM_PROMPT = """You repair OCR-corrupted text from a scanned FAA Legal Interpretation letter. The document's actual words are all still recoverable from context -- your ONLY job is undoing OCR damage: spurious spaces splitting words apart ("Thi s is i n response t o your"), and character-substitution misreads ("Deportment" for "Department", "AviQlian" for "Aviation").

HARD RULES:
- Fix ONLY the OCR corruption. Never paraphrase, reword, summarize, or improve the writing.
- Never add, remove, or reorder a sentence, clause, or fact.
- Never change a number, date, section citation, or name -- if a digit sequence looks corrupted, leave it exactly as given rather than guessing what it should be.
- If a word or phrase is too damaged to confidently reconstruct, leave it exactly as it appears in the source rather than inventing a plausible-sounding replacement.
- Preserve the original paragraph breaks and overall structure.

Respond with JSON only: {"cleaned_text": "..."}"""

FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {"cleaned_text": {"type": "string"}},
        "required": ["cleaned_text"],
        "additionalProperties": False,
    },
}


def fetch_sources(limit):
    q = """
        select slug, title, body_text
        from legal_interpretations
        where ocr_quality_score >= 3.0 and ocr_quality_score < 6.0
          and body_text is not null and length(body_text) > 200
        order by ocr_quality_score desc
    """
    if limit:
        q += f" limit {limit}"
    return mgmt_sql(q)


def build_request(row, custom_id):
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    user_content = f"{row['title']}\n\nOCR TEXT TO REPAIR:\n{row['body_text']}"
    # A fixed 8000 truncated the longest doc in the first validation batch
    # mid-JSON-string (28,197-char source, real output needed >8000 tokens
    # since this is reconstruction, not summarization -- cleaned length
    # tracks source length closely). Scale to the source instead: ~1 output
    # token per 3 source chars (generous vs. the ~4 chars/token JSON text
    # actually runs, covering json-escaping overhead) plus a fixed buffer
    # for the {"cleaned_text": "..."} wrapper, capped at 16000.
    max_tokens = min(16000, len(row["body_text"]) // 3 + 1000)
    return Request(
        custom_id=custom_id,
        params=MessageCreateParamsNonStreaming(
            model=MODEL,
            max_tokens=max_tokens,
            system=SYSTEM_PROMPT,
            # No "effort" key here -- Haiku 4.5 doesn't support the
            # extended-thinking effort parameter (confirmed live: every
            # request in the first test batch errored with "This model does
            # not support the effort parameter" before this was removed).
            output_config={"format": FORMAT},
            messages=[{"role": "user", "content": user_content}],
        ),
    )


def cmd_submit(limit):
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
        if state.get("status") != "ended":
            print(f"Refusing to resubmit -- batch {state['batch_id']} already exists "
                  f"(status last seen: {state.get('status')}). Run --poll instead, or "
                  f"delete {STATE_PATH} if you're certain it's safe to resubmit.")
            sys.exit(1)

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    sources = fetch_sources(limit)
    print(f"Fetched {len(sources)} LOIs in the mild/moderate (3.0-6.0) tier"
          f"{f' (limited to {limit})' if limit else ''}.")
    if not sources:
        print("Nothing to clean up.")
        return

    id_map, sources_snapshot, requests_ = {}, {}, []
    for seq, row in enumerate(sources):
        cid = f"loi_{seq}"
        id_map[cid] = {"slug": row["slug"]}
        sources_snapshot[row["slug"]] = row["body_text"]
        requests_.append(build_request(row, cid))
    json.dump(id_map, open(ID_MAP_PATH, "w"))
    json.dump(sources_snapshot, open(SNAPSHOT_PATH, "w"))

    total_chars = sum(len(r["body_text"]) for r in sources)
    est_input_tokens = total_chars // 4 + len(sources) * 150
    est_output_tokens = total_chars // 4 + len(sources) * 20
    est_cost = est_input_tokens / 1_000_000 * 0.5 + est_output_tokens / 1_000_000 * 2.5
    print(f"Estimated ~{est_input_tokens:,} input / ~{est_output_tokens:,} output tokens, "
          f"~${est_cost:.2f} (batch-rate, Haiku 4.5).")

    batch = client.messages.batches.create(requests=requests_)
    state = {"batch_id": batch.id, "status": batch.processing_status,
              "item_count": len(sources), "created_at": time.time()}
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    print(f"Batch submitted: {batch.id} (status: {batch.processing_status})")
    print("State saved. Run --poll to check progress / ingest when done.")


DIGIT_RUN_RE = re.compile(r"\d{2,}")


def grounding_ok(original, cleaned):
    if not cleaned or not cleaned.strip():
        return False, "empty result"
    ratio = len(cleaned) / max(len(original), 1)
    if not (0.90 <= ratio <= 1.10):
        return False, f"length ratio {ratio:.2f} outside [0.90, 1.10]"
    orig_digit_runs = set(DIGIT_RUN_RE.findall(original))
    missing = [d for d in orig_digit_runs if d not in cleaned]
    if missing:
        return False, f"{len(missing)} digit sequence(s) from the original missing in the cleaned text (e.g. {missing[:5]})"
    return True, None


def cmd_poll(limit):
    if not os.path.exists(STATE_PATH):
        print(f"No batch state found at {STATE_PATH} -- run --submit first.")
        sys.exit(1)
    state = json.load(open(STATE_PATH))

    import anthropic
    env = load_env(".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    batch = client.messages.batches.retrieve(state["batch_id"])
    print(f"Batch {batch.id}: {batch.processing_status}  "
          f"(succeeded={batch.request_counts.succeeded} errored={batch.request_counts.errored} "
          f"processing={batch.request_counts.processing})")
    state["status"] = batch.processing_status
    json.dump(state, open(STATE_PATH, "w"), indent=2)
    if batch.processing_status != "ended":
        print("Not done yet. Re-run --poll later.")
        return

    id_map = json.load(open(ID_MAP_PATH))
    snapshot = json.load(open(SNAPSHOT_PATH))

    accepted, rejected, shape_bad, errored = 0, 0, 0, 0
    total_in_tok, total_out_tok = 0, 0
    writes = []
    rejections = []

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
            shape_bad += 1
            continue
        mapped = id_map.get(result.custom_id)
        if not mapped:
            shape_bad += 1
            continue
        slug = mapped["slug"]
        original = snapshot.get(slug, "")
        cleaned = parsed.get("cleaned_text", "")
        ok, reason = grounding_ok(original, cleaned)
        if not ok:
            rejected += 1
            rejections.append((slug, reason))
            continue
        accepted += 1
        writes.append((slug, cleaned))

    print(f"\nParsed {batch.request_counts.succeeded} responses: {accepted} passed grounding checks, "
          f"{rejected} rejected (failed a safety check, left untouched), {shape_bad} unmapped/bad shape, "
          f"{errored} request errors.")
    if rejections:
        print("Rejected (left untouched):")
        for slug, reason in rejections[:20]:
            print(f"  {slug}: {reason}")

    cost = total_in_tok / 1_000_000 * 0.5 + total_out_tok / 1_000_000 * 2.5
    print(f"Actual usage: {total_in_tok:,} input / {total_out_tok:,} output tokens "
          f"-> ~${cost:.2f} at Haiku 4.5 batch rate.")

    if not writes:
        print("Nothing to write.")
        return

    written = 0
    for slug, cleaned in writes:
        # ocr_cleaned_at: real data-loss bug, 2026-08-23 -- without this
        # flag, loi_scraper.py's next weekly re-sync unconditionally
        # overwrites body_text from DRS's raw OCR layer again, silently
        # reverting this exact fix. See migrations_loi_ocr_cleaned_flag.sql.
        status, err = rest("PATCH", f"/rest/v1/legal_interpretations?slug=eq.{slug}",
                            body={"body_text": cleaned, "ocr_cleaned_at": datetime.now(timezone.utc).isoformat()})
        if status >= 300:
            print(f"  write {slug}: HTTP {status}: {err}")
        else:
            written += 1
    print(f"Wrote {written}/{len(writes)} cleaned bodies. "
          f"Now re-run: python3 scripts/loi_quality_scan.py --backfill (scores don't auto-refresh).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    if args.submit:
        cmd_submit(args.limit)
    elif args.poll:
        cmd_poll(args.limit)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
