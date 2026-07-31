#!/bin/bash
# FlyRegs AD sync — Airworthiness Directives.
#
# Confirmed a real, live gap on 2026-07-28: ad_scraper.py already had a
# purpose-built `incremental` mode ("what the weekly sync actually uses",
# per its own header) and send-ad-alerts.mjs already existed to notify
# My Aircraft users of newly-touched ADs -- but no schedule of any kind
# ever called either one. AD data and targeted alerts were 100% manual
# since the AD expansion shipped.
#
# Steps:
#   1. sync/ad_scraper.py --mode incremental -- only ADs published since
#      the most recent citation_publish_date already in the DB, writing
#      every touched ad_number to a temp file.
#   2. sync/extract_ad_parts.py --mode full --touched-file -- named-parts
#      extraction (Claude Haiku) scoped to just this run's touched ADs,
#      so it's cheap/safe to run unattended (the one-time full-corpus
#      backfill is separate and needs an explicit human go-ahead first,
#      see that script's own header). Runs BEFORE step 3 on purpose: it
#      populates ad_part_mentions for the ADs this run touched, which
#      send-ad-alerts.mjs's part-keyed matching (added 2026-07-28) then
#      reads in the same run -- so a brand-new part-keyed AD can still
#      alert a tagged owner the same week it's published, not a week late.
#   3. scripts/send-ad-alerts.mjs -- targeted push notifications to
#      My Aircraft users whose saved make/model matches a touched AD, or
#      whose tagged equipment matches a part-keyed AD.
#   4. sync/ad_citations.py -- MagicLink citation extraction (AD ->
#      AC/FAR/AIM mentions), full corpus re-scan. Was written this same
#      week but had never actually been run before 2026-07-28 (see
#      flyregs_gotchas.md) -- wiring it here is what keeps it from
#      silently going stale again the way it already did once.
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-ad-sync.yml) — same reasoning as sync.sh/
# sync_far.sh/sync_aim.sh/sync_pcg.sh: doesn't depend on any one machine
# being on. Can still be run locally for testing by creating a
# `.env.scraper` file in this directory (SUPABASE_URL +
# SUPABASE_SERVICE_KEY, gitignored, never commit it) — same file the
# other sync scripts use.
#
# Usage:
#   ./sync_ad.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"
NODE="${NODE:-node}"
TOUCHED_FILE="$(mktemp -t flyregs-ad-touched.XXXXXX)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (SUPABASE_URL + SUPABASE_SERVICE_KEY)" >&2
  exit 1
fi

# ENV_FILE already has real "export VAR=..." lines -- source it directly
# (no process substitution) for portability across shells/sandboxes;
# confirmed live that piping through <(...) is unreliable in some
# execution environments even with the vars right there in the file.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs AD Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"

echo ""
echo "▶ Step 1/8 — AD incremental scrape"
"$PYTHON3" sync/ad_scraper.py --mode incremental --touched-out="$TOUCHED_FILE"

echo ""
echo "▶ Step 2/8 — AD parts extraction (ADs touched this run)"
"$PYTHON3" sync/extract_ad_parts.py --mode full --touched-file="$TOUCHED_FILE"

echo ""
echo "▶ Step 3/8 — Targeted My Aircraft alerts (ADs touched this run)"
"$NODE" scripts/send-ad-alerts.mjs --touched-file="$TOUCHED_FILE"

echo ""
echo "▶ Step 4/8 — MagicLink citation extraction (AD -> AC/FAR/AIM/AD)"
# Order-independent as of 2026-07-31: ad_citations.py's delete used to remove
# EVERY citing_type='ad' row, including the ~450 ad->pcg links Step 6 owns, so
# it was only safe here by accident of ordering. Its delete is now scoped to
# cited_type in (ac,far,aim,ad). Verified by running it standalone: ad->pcg
# stayed at 452 where it previously dropped to 0.
"$PYTHON3" sync/ad_citations.py

# ── Step 5: SmartSearch index ────────────────────────────────────────────
# Rebuilds search_vocabulary + search_term_associations from the whole
# corpus. MUST run BEFORE Step 6: pcg_term_links.py reads
# search_vocabulary.doc_freq to decide whether a single-word P/CG term is
# specific enough to link, so a stale vocabulary silently degrades the
# quality filter (and SmartSearch expansion along with it).
echo ""
echo "▶ Step 5/8 — SmartSearch index rebuild (vocabulary + term associations)"
"$PYTHON3" sync/search_index_build.py

echo ""
# ── Step 6: corpus-wide P/CG term linking ────────────────────────────────
# WHY THIS LIVES IN THE *AD* SCRIPT (it is not an AD concern):
# pcg_term_links.py is a FULL-CORPUS rebuild -- it re-scans FAR + AIM + AC +
# AD + LOI for P/CG glossary phrases and rewrites every cited_type='pcg' row
# in one pass. It therefore has to run AFTER every content table is current,
# and the AD sync is the last weekly job of the week (Mon 14:00 UTC, after
# AC 10:00 / AIM 11:00 / FAR 12:00 / P-CG 13:00 -- see .github/workflows/).
# Running it from each type's own sync instead would repeat the same
# whole-corpus scan five times and leave the first four runs stale.
# sync_pcg.sh carries a pointer comment back to here so this stays findable.
#
# Idempotent by design: it deletes the rows it owns before reinserting, so a
# re-run can't multiply them (document_citations has no unique constraint).

echo "▶ Step 6/8 — MagicLink P/CG term linking (FAR/AIM/AC/AD/LOI -> P/CG, full corpus)"
"$PYTHON3" sync/pcg_term_links.py

# ── Step 7: P/CG knowledge-level classification ───────────────────────────
# MUST follow Step 6. pcg_term_levels classifies each glossary term by the
# levels of the documents that cite it, so it reads Step 6's output directly.
# If Step 6 changes the links and this doesn't re-run, the Study Mode and
# Duels level filters silently drift out of sync with the corpus.
echo ""
echo "▶ Step 7/8 — P/CG knowledge-level classification"
"$PYTHON3" sync/refresh_pcg_levels.py

# ── Step 7: LOI -> AC links ───────────────────────────────────────────────
# Lives here for the same reason Steps 5-6 do: it is a full-corpus re-scan,
# and there is no sync_loi.sh (LOI enumeration is a manual capture, not a
# weekly cron). Owns ONLY citing_type='loi' + cited_type='ac' -- loi->far
# belongs to loi_scraper.py and loi->pcg to Step 6, and its delete is scoped
# so it cannot touch either.
echo ""
echo "▶ Step 8/8 — MagicLink LOI -> AC links (full corpus)"
"$PYTHON3" sync/loi_ac_citations.py

rm -f "$TOUCHED_FILE"

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  AD sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
