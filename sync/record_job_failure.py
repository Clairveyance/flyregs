#!/usr/bin/env python3
"""Leave a trace in the database when a scheduled sync dies.

WHY THIS EXISTS
---------------
Weekly LOI Sync failed on 2026-08-31 with a DRS 503, and nothing anywhere
said so. Not an email, not a row, nothing -- only a red run in the GitHub
Actions tab that nobody watches. It was found five days later, by hand.

scraper_freshness_check.py was built for exactly this and still could not
see it, for a reason worth stating plainly: it detects absence of evidence.
A crashed scraper never gets far enough to write its scraper_runs row, so
the failure is indistinguishable from "not Monday yet" until a full week
has passed. That is a week of a stale corpus with What's New quietly
under-reporting.

So the workflow records the failure itself, in an `if: failure()` step that
runs after the scraper has already died. The row lands in the same table
every successful run writes to, with status 'failed' and the run's URL in
notes, which means the existing freshness check surfaces it on the next
audit run instead of a week later.

The corpus's own count column is set to 0 rather than left null -- that is
what makes the row VISIBLE to scraper_freshness_check, which finds each
corpus's latest run by "the column only that corpus populates is not null".
A null there would leave the failure invisible all over again. Because that
same check keys off recency, it also had to learn that status='failed' is a
failure and not a fresh success; both halves shipped together, and one
without the other is worse than neither.

Usage (from a workflow):
  python3 sync/record_job_failure.py --corpus LOI \\
      --workflow "$GITHUB_WORKFLOW" \\
      --run-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

# corpus -> the scraper_runs column that only that corpus populates. Must
# stay in step with scripts/scraper_freshness_check.py's CORPORA map: this
# writes the row that one reads.
CORPUS_COLUMN = {
    "AC": "acs_total",
    "FAR": "far_sections_total",
    "AIM": "aim_paragraphs_total",
    "PCG": "pcg_total",
    "AD": "ad_total",
    "LOI": "loi_total",
    "49CFR": "cfr49_total",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, choices=sorted(CORPUS_COLUMN))
    ap.add_argument("--workflow", default="(unknown workflow)")
    ap.add_argument("--run-url", default="")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not (url and key):
        print("record_job_failure: no Supabase credentials in the environment; "
              "cannot record the failure", file=sys.stderr)
        return 0            # never turn a sync failure into a second failure

    now = datetime.now(timezone.utc).isoformat()
    row = {
        "id": str(uuid.uuid4()),
        "mode": "full",
        "started_at": now,
        "completed_at": now,
        "status": "failed",
        CORPUS_COLUMN[args.corpus]: 0,
        "notes": f"{args.workflow} failed. {args.run_url}".strip(),
    }
    req = urllib.request.Request(
        f"{url}/rest/v1/scraper_runs", data=json.dumps(row).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"record_job_failure: recorded {args.corpus} failure (HTTP {r.status})")
    except urllib.error.HTTPError as e:
        # Reported, not raised. This step exists to make a failure visible;
        # if it cannot, the original failure is still the one that matters
        # and masking it behind a second error helps nobody.
        print(f"record_job_failure: could not record: HTTP {e.code} "
              f"{e.read().decode()[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"record_job_failure: could not record: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
