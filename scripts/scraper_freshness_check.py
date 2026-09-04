"""Alarm when any corpus has not been scraped in over a week.

RC, 2026-09-01: "I'm suspicious that our What's New area is not fully capturing
all current regs. Let's make sure that all of our scraping automation is set up
and working properly so that all regs are being looked at at least once a week."

The schedules were all present and correct (seven weekly workflows, staggered
Mondays 10:00-16:00 UTC). What was missing was any CHECK that they actually
ran. Nothing in scripts/ referenced scraper_runs at all, so a corpus could stop
syncing indefinitely and the only trace would be a red run in the GitHub
Actions tab that nobody watches.

Proven by the case that prompted this: LOI last recorded a run on 2026-08-24
and silently missed its 2026-08-31 Monday. sync_loi.sh does pass --mode full,
so the run-logging path was fine -- the job almost certainly died earlier, in
the DRS session-refresh step (DRS sits behind Akamai bot detection and its
guest JWT lives ~12 hours). A failure there happens BEFORE loi_scraper.py runs,
so it leaves no scraper_runs row whatsoever. That is exactly the shape this
check is built to catch: absence of evidence.

Threshold is 7 days. A Monday job checked the following Monday is exactly 7 and
passes; anything older has genuinely skipped a cycle. Set to 8 initially, which
let the very case that motivated this (LOI, 8 days) slip through -- the whole
point is to catch a MISSED Monday, and a job that ran last Monday instead of
this one is exactly 8 days old.
"""
import sys, argparse
sys.path.insert(0, "scripts")
from author_fact_deck import mgmt_sql

# corpus -> the scraper_runs column that only that corpus populates
CORPORA = {
    "AC":    "acs_total",
    "FAR":   "far_sections_total",
    "AIM":   "aim_paragraphs_total",
    "PCG":   "pcg_total",
    "AD":    "ad_total",
    "LOI":   "loi_total",
    "49CFR": "cfr49_total",
}
MAX_AGE_DAYS = 7

def check(max_age=MAX_AGE_DAYS):
    stale, missing, ok, failed = [], [], [], []
    for name, col in CORPORA.items():
        rows = mgmt_sql(f"""select started_at::date d, status,
                              extract(day from now() - started_at)::int age
                            from scraper_runs where {col} is not null
                            order by started_at desc limit 1""")
        if not rows:
            missing.append(name); continue
        r = rows[0]
        if r["status"] == "failed":
            failed.append((name, r["d"], r["age"], r["status"]))
        elif r["age"] > max_age:
            stale.append((name, r["d"], r["age"], r["status"]))
        else:
            ok.append((name, r["d"], r["age"], r["status"]))
    for n, d, a, s in sorted(ok, key=lambda x: x[2]):
        print(f"  OK    {n:<7} last run {d} ({a}d ago, {s})")
    for n, d, a, s in stale:
        print(f"  STALE {n:<7} last run {d} ({a}d ago, {s})  <-- over {max_age} days")
    for n, d, a, s in failed:
        print(f"  FAILED {n:<6} last run {d} ({a}d ago) DIED -- see notes on that "
              f"scraper_runs row for the GitHub run URL")
    for n in missing:
        print(f"  NONE  {n:<7} has NEVER recorded a run")
    return stale, missing, failed

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age-days", type=int, default=MAX_AGE_DAYS)
    args = ap.parse_args()
    print(f"Scraper freshness (threshold {args.max_age_days} days):")
    stale, missing, failed = check(args.max_age_days)
    if stale or missing or failed:
        # A recorded failure is the case this check was blind to until
        # 2026-09-04: a scraper that DIES writes no row at all, so absence
        # of evidence looked identical to "not Monday yet" for a full week.
        # sync/record_job_failure.py now writes a status='failed' row from
        # the workflow's own if: failure() step -- but that row is RECENT,
        # so without this branch it would have read as a fresh success and
        # made things worse rather than better.
        print(f"\nFAIL: {len(stale)} stale, {len(missing)} never ran, "
              f"{len(failed)} died mid-run. "
              f"A corpus not scraped weekly means What's New cannot report its changes.")
        sys.exit(1)
    print("\nAll corpora scraped within the window.")
